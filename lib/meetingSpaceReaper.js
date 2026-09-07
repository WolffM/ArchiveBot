/**
 * Expiry sweep and invite→role binding for meeting spaces.
 *
 * Two jobs that both exist because Discord will not do them for us.
 *
 * ## The sweep
 *
 * Deletes an expired space's category (which takes its channels with it) and
 * its role, then kicks the member who joined through it. This is NOT tidiness:
 * a guild caps at 500 channels and 250 roles, each space costs 3 and 1, so a
 * stalled sweep means provisioning starts failing at ~166 live spaces. It
 * returns counts so a caller can log them and a stall is visible before the
 * ceiling is hit.
 *
 * Order matters. The kick happens BEFORE the role is deleted, purely so the
 * audit-log reason can still name the space. If the kick fails the teardown
 * still proceeds — a guest who lingers in the guild is untidy, whereas a
 * category that survives its sweep is a permanent charge against the ceiling.
 *
 * Deletion is idempotent by construction: anything already gone (deleted by
 * hand, or by a previous half-finished sweep) is treated as success, so a
 * space can never wedge the sweep by being partially cleaned up.
 *
 * ## The invite binding
 *
 * Discord invites do not carry roles — there is no "join with this role" link.
 * The only way to know which invite someone used is to cache every invite's
 * use count and diff it on `guildMemberAdd`. That is what `bindInviteUses` and
 * `handleMemberAdd` do.
 *
 * The race is real and worth naming: two people joining within the same tick
 * can be attributed to the wrong invite. It is mitigated, not eliminated —
 * every space invite is `maxUses: 1`, so a consumed invite DISAPPEARS from the
 * guild's invite list rather than merely incrementing. A vanished code is a far
 * stronger signal than a count that went up, and two simultaneous joins would
 * have to consume two invites in the same instant to confuse it. Where the
 * signal is ambiguous the member is left roleless rather than guessed at:
 * putting a stranger in the wrong private space is the one outcome worse than
 * making them ask.
 */

const { createLogger } = require('../utils/logger');
const { mirrorToLedger, mirrorFailureToLedger } = require('./ledger');
const store = require('./meetingSpaceStore');

const log = createLogger('meetingSpaceReaper');

/** guildId -> Map<inviteCode, uses> captured at the last observation. */
const inviteCache = new Map();

/**
 * Snapshot a guild's invites. Called on ready and after every join, so the
 * cache reflects reality before the next diff.
 */
async function cacheGuildInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        const snapshot = new Map();
        invites.forEach((inv) => snapshot.set(inv.code, inv.uses ?? 0));
        inviteCache.set(guild.id, snapshot);
        return snapshot;
    } catch (err) {
        // Missing MANAGE_GUILD means we cannot read invites at all; the binding
        // degrades to "no role assigned" rather than to a wrong assignment.
        log.warn('invite_cache_failed', { guildId: guild.id, error: err.message });
        inviteCache.delete(guild.id);
        return null;
    }
}

/**
 * Which space's invite was consumed by this join?
 *
 * A `maxUses: 1` invite is deleted by Discord the moment it is used, so the
 * strongest signal is a code that was in the cache and is now absent. Falling
 * back to a use-count increase covers an invite that somehow survived.
 * Ambiguity (more than one candidate) returns null on purpose.
 */
function resolveConsumedCode(before, after) {
    if (!before) return null;

    const vanished = [...before.keys()].filter((code) => !after.has(code));
    if (vanished.length === 1) return vanished[0];
    if (vanished.length > 1) return null; // ambiguous — refuse to guess

    const incremented = [...after.entries()]
        .filter(([code, uses]) => before.has(code) && uses > before.get(code))
        .map(([code]) => code);
    return incremented.length === 1 ? incremented[0] : null;
}

/**
 * `guildMemberAdd` handler. Assigns the space role when the join can be
 * attributed to a space invite with confidence, and records the member so the
 * sweep knows who to kick.
 */
async function handleMemberAdd(member) {
    const guild = member.guild;
    const before = inviteCache.get(guild.id);
    const after = (await cacheGuildInvites(guild)) ?? new Map();

    const code = resolveConsumedCode(before, after);
    if (!code) {
        log.info('join_unattributed', { guildId: guild.id, memberId: member.id });
        return null;
    }

    const space = store.findByInviteCode(guild.id, code);
    if (!space) {
        // A normal server invite, not one of ours. Nothing to do.
        return null;
    }

    try {
        await member.roles.add(space.roleId, `meeting space ${space.spaceId}`);
        store.setMember(guild.id, space.spaceId, member.id);
        log.info('space_member_bound', { spaceId: space.spaceId, memberId: member.id });
        return space;
    } catch (err) {
        log.error('space_role_assign_failed', err, { spaceId: space.spaceId, memberId: member.id });
        mirrorFailureToLedger('archivebot.space', 'role not assigned on join', {
            spaceId: space.spaceId,
            guildId: guild.id,
            error: err,
        });
        return null;
    }
}

/** Delete a thing, treating "already gone" as success. */
async function deleteIfPresent(fetcher, reason) {
    try {
        const thing = await fetcher();
        if (!thing) return true;
        await thing.delete(reason);
        return true;
    } catch (err) {
        // 10003 unknown channel / 10011 unknown role — already gone.
        if (err?.code === 10003 || err?.code === 10011) return true;
        throw err;
    }
}

/**
 * Tear one space down. Returns what happened rather than throwing, so one
 * stubborn space cannot abort the whole sweep.
 */
async function teardownSpace(guild, space) {
    const outcome = { spaceId: space.spaceId, kicked: false, deleted: false, errors: [] };

    // Kick first, while the role still exists to name in the audit reason.
    if (space.memberId) {
        try {
            const member = await guild.members.fetch(space.memberId).catch(() => null);
            if (member) {
                if (member.id === guild.ownerId) {
                    // Never kick the owner. Cannot happen through a guest invite,
                    // but a hand-edited store must not brick the guild.
                    outcome.errors.push('refused_to_kick_owner');
                } else if (member.kickable) {
                    await member.kick(`meeting space ${space.spaceId} expired`);
                    outcome.kicked = true;
                } else {
                    outcome.errors.push('member_not_kickable');
                }
            }
        } catch (err) {
            outcome.errors.push(`kick_failed:${err.message}`);
        }
    }

    try {
        // Deleting the category takes its channels with it.
        await deleteIfPresent(
            () => guild.channels.fetch(space.categoryId).catch(() => null),
            `meeting space ${space.spaceId} expired`
        );
        await deleteIfPresent(
            () => guild.roles.fetch(space.roleId).catch(() => null),
            `meeting space ${space.spaceId} expired`
        );
        outcome.deleted = true;
    } catch (err) {
        outcome.errors.push(`delete_failed:${err.message}`);
    }

    // Only retire the record once the channels are actually gone. A space left
    // active is retried next sweep; one marked inactive with live channels is
    // invisible and charges the ceiling forever.
    if (outcome.deleted) {
        store.markInactive(guild.id, space.spaceId, { teardownErrors: outcome.errors });
    }

    return outcome;
}

/**
 * Sweep every guild with a spaces store. Safe to call on a timer; returns a
 * summary so the caller can log a stall into visibility.
 */
async function sweepExpiredSpaces(discordClient, now = Date.now()) {
    const summary = { swept: 0, kicked: 0, failed: 0, guilds: 0 };

    for (const guildId of store.listGuildIds()) {
        const expired = store.findExpired(guildId, now);
        if (expired.length === 0) continue;
        summary.guilds++;

        let guild;
        try {
            guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
        } catch (err) {
            log.error('sweep_guild_unreachable', err, { guildId });
            summary.failed += expired.length;
            continue;
        }

        for (const space of expired) {
            const outcome = await teardownSpace(guild, space);
            if (outcome.deleted) summary.swept++;
            else summary.failed++;
            if (outcome.kicked) summary.kicked++;
            if (outcome.errors.length) {
                log.warn('space_teardown_issues', { spaceId: space.spaceId, errors: outcome.errors });
            }
        }
    }

    if (summary.swept || summary.failed) {
        log.info('space_sweep', summary);
        mirrorToLedger('archivebot.space', 'expired spaces swept', summary);
    }
    return summary;
}

module.exports = {
    cacheGuildInvites,
    handleMemberAdd,
    resolveConsumedCode,
    teardownSpace,
    sweepExpiredSpaces,
    inviteCache,
};
