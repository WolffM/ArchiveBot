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
 * ## When teardown cannot succeed
 *
 * Retrying assumes the next attempt might work. For a category the bot cannot
 * SEE that assumption is false forever: Discord refuses to manage an invisible
 * channel, so `Missing Access` is a permanent verdict, not a transient one.
 * Spaces provisioned before the bot granted itself a ViewChannel overwrite are
 * exactly this, and they failed the 60-second sweep indefinitely.
 *
 * Two mechanisms answer that. `recoverCategoryAccess` gets back in by wearing
 * the guest role, which fixes the case outright. Anything it cannot rescue is
 * parked as `stuck` after MAX_TEARDOWN_ATTEMPTS: alerted once, reported with
 * the channel and role an operator must delete, and then left alone. A job
 * that is red every day forever is not an alarm, it is background noise that
 * hides the next real one.
 *
 * Parking is deliberately narrow. It requires BOTH the attempt count and a
 * failure proven unable to heal — a category the bot cannot see and could not
 * get back into. Every other failure keeps failing the job, because a stall
 * that might still clear must stay loud. Silencing an alarm you have not
 * diagnosed is the same bug as never raising one.
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

/**
 * How many failed sweeps before a PERMANENTLY broken space is parked.
 *
 * The count alone is not enough to park on, and the cron schedule is why. The
 * fleet profile runs this job once a day with max_attempts 3 at 60s/120s, so
 * three attempts span about three minutes — a Discord outage that long would
 * park a space that was going to heal on its own, and parking silences the
 * alarm. So `permanent` is required alongside the count: only a failure that
 * cannot heal is parked, and anything else keeps failing the job loudly, which
 * is the correct behaviour for a real stall.
 */
const MAX_TEARDOWN_ATTEMPTS = 3;

/** Discord: the bot cannot SEE the channel. Distinct from 50013, which is
 *  "can see it, may not touch it" — only the former is recoverable here. */
const MISSING_ACCESS = 50001;

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
 * Get back into a category the bot cannot see, by wearing the guest's role.
 *
 * Spaces provisioned before the bot granted itself a ViewChannel overwrite are
 * invisible to it, and Discord refuses to let you manage a channel you cannot
 * see — so `delete` answers `Missing Access` forever and no amount of retrying
 * helps. That is a permanent state for those records, not a transient one.
 *
 * But the space's own ROLE is granted ViewChannel on that very category, and
 * the bot can still manage that role: the bot created it, so it sits below the
 * bot's own role in the hierarchy. So the bot wears the guest role for the
 * length of one delete call. This needs nothing the bot does not already have
 * (guild MANAGE_ROLES, which it uses to create the role in the first place),
 * and it is self-cleaning — deleting the role, the very next teardown step,
 * removes it from the bot too.
 *
 * Returns whether the category is now gone. Never throws: a failed recovery
 * must leave the caller's original error intact rather than replacing it with
 * a second, less informative one.
 */
async function recoverCategoryAccess(guild, space, reason) {
    if (!space.roleId) return false;

    const me = guild.members.me ?? (await guild.members.fetchMe?.().catch(() => null));
    if (!me) return false;

    let wearing = false;
    try {
        await me.roles.add(space.roleId, `${reason} — teardown access recovery`);
        wearing = true;

        // Children AND the category — recovery that deleted only the category
        // would strand the `chat` and `Meeting Room` channels in exactly the
        // way the cascade assumption did, just by a different route.
        await deleteSpaceChannels(guild, space, reason);
        log.info('teardown_recovered', { spaceId: space.spaceId, categoryId: space.categoryId });
        return true;
    } catch (err) {
        log.warn('teardown_recovery_failed', { spaceId: space.spaceId, error: err.message });
        return false;
    } finally {
        // Deleting the role drops it from the bot anyway; this covers the path
        // where the role outlives the attempt, so a failed recovery does not
        // leave the bot holding a guest role into somebody's private space.
        if (wearing) await me.roles.remove(space.roleId, reason).catch(() => {});
    }
}

/**
 * Delete a space's channels, then its category.
 *
 * ORDER IS LOad-BEARING: Discord does NOT cascade. Deleting a category leaves
 * its channels alive and merely uncategorised, which is how the guild filled
 * with loose `chat` and `Meeting Room` channels that no sweep collected —
 * their records were already inactive, so nothing looked at them again, and
 * each pair kept charging the 500-channel ceiling.
 *
 * One function so the caller's Missing-Access recovery wraps BOTH halves: a
 * child hidden from the bot needs exactly the same remedy as a hidden
 * category, and recovering for one but not the other would strand the rest.
 */
async function deleteSpaceChannels(guild, space, reason) {
    for (const childId of Array.isArray(space.channelIds) ? space.channelIds : []) {
        await deleteIfPresent(() => guild.channels.fetch(childId).catch(() => null), reason);
    }
    await deleteIfPresent(() => guild.channels.fetch(space.categoryId).catch(() => null), reason);
}

/**
 * Tear one space down. Returns what happened rather than throwing, so one
 * stubborn space cannot abort the whole sweep.
 */
async function teardownSpace(guild, space) {
    const outcome = {
        spaceId: space.spaceId,
        kicked: false,
        deleted: false,
        recovered: false,
        // Set only for a failure that cannot heal on a later attempt. The sweep
        // refuses to park anything without it — see MAX_TEARDOWN_ATTEMPTS.
        permanent: false,
        errors: [],
    };

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

    const reason = `meeting space ${space.spaceId} expired`;

    try {
        // DELETE THE CHILD CHANNELS FIRST. Discord does NOT cascade: deleting a
        // category leaves its channels alive and merely uncategorised. This
        // code asserted the opposite in a comment for several commits, which is
        // how the guild filled with loose `chat` and `Meeting Room` channels
        // that no sweep would ever collect — their records were already marked
        // inactive, so nothing looked at them again, and every pair kept
        // charging the 500-channel ceiling.
        //
        // channelIds has been recorded at provision time since the beginning;
        // it was simply never read. A record predating the field just has none,
        // and the category delete below still runs.
        try {
            await deleteSpaceChannels(guild, space, reason);
        } catch (err) {
            // Missing Access means the bot cannot see the category, so it can
            // never manage it and retrying next minute changes nothing. Wearing
            // the guest role is the one way back in — see recoverCategoryAccess.
            if (err?.code !== MISSING_ACCESS) throw err;
            outcome.recovered = await recoverCategoryAccess(guild, space, reason);
            if (!outcome.recovered) {
                // Invisible to the bot, and wearing the role did not get it
                // back in. Nothing about waiting changes either fact, so this
                // is the one failure the sweep is allowed to stop retrying.
                outcome.permanent = true;
                throw err;
            }
        }
        await deleteIfPresent(
            () => guild.roles.fetch(space.roleId).catch(() => null),
            reason
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
 * What an operator actually has to DO about a space the bot cannot reap.
 *
 * A count is not an instruction. `failed=2`, repeated every 60 seconds, told
 * nobody which spaces, why, or what would clear it — so it read as noise and
 * got treated as noise. Every report of a stuck space carries this line.
 */
function remediation(space) {
    return (
        `Delete category ${space.categoryId} and role ${space.roleId} by hand in Discord ` +
        `(they still count against the 500-channel / 250-role ceilings), then POST ` +
        `/api/spaces/revoke with spaceId=${space.spaceId} to retire the record.`
    );
}

/**
 * Sweep every guild with a spaces store. Safe to call on a timer; returns a
 * summary so the caller can log a stall into visibility.
 *
 * Failures come in two kinds and the distinction is the point:
 *
 *   `failed` — tried, did not work, will be tried again next sweep. A real
 *              stall alarm: this is what should fail the cron job.
 *   `stuck`  — tried MAX_TEARDOWN_ATTEMPTS times and parked. Already alerted
 *              once, already carries its remediation, and is deliberately NOT
 *              retried, because a permanently undeletable space that keeps
 *              failing the job every minute is how a real stall goes unnoticed.
 */
async function sweepExpiredSpaces(discordClient, now = Date.now()) {
    const summary = { swept: 0, kicked: 0, failed: 0, stuck: 0, guilds: 0, attention: [] };

    for (const guildId of store.listGuildIds()) {
        const expired = store.findExpired(guildId, now);
        // Report spaces already parked even when there is nothing left to try,
        // so an outstanding one does not vanish from the summary the moment the
        // queue drains.
        for (const parked of store.listStuck(guildId)) {
            summary.attention.push({
                spaceId: parked.spaceId,
                guildId,
                categoryId: parked.categoryId,
                roleId: parked.roleId,
                lastError: parked.lastTeardownError,
                action: remediation(parked),
            });
        }

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
            if (outcome.kicked) summary.kicked++;

            if (outcome.deleted) {
                summary.swept++;
                if (outcome.recovered) {
                    log.info('space_swept_after_recovery', { spaceId: space.spaceId });
                }
                continue;
            }

            const record = store.recordTeardownFailure(guildId, space.spaceId, outcome.errors);
            const attempts = record?.teardownAttempts ?? MAX_TEARDOWN_ATTEMPTS;

            // A transient failure keeps failing the job however many times it
            // recurs. That is not an oversight: the job going red IS the stall
            // alarm, and a space that might still heal must not be quietly
            // taken out of the queue.
            if (!outcome.permanent || attempts < MAX_TEARDOWN_ATTEMPTS) {
                summary.failed++;
                log.warn('space_teardown_issues', {
                    spaceId: space.spaceId,
                    attempts,
                    permanent: outcome.permanent,
                    errors: outcome.errors,
                });
                continue;
            }

            // Park it, and say so exactly once — the alert fires on the
            // transition, not on every sweep that finds it still parked.
            store.markStuck(guildId, space.spaceId);
            const detail = {
                spaceId: space.spaceId,
                guildId,
                categoryId: space.categoryId,
                roleId: space.roleId,
                attempts,
                lastError: outcome.errors.join('; '),
                action: remediation(space),
            };
            summary.attention.push(detail);
            log.error('space_teardown_stuck', null, detail);
            mirrorFailureToLedger(
                'archivebot.space',
                `space ${space.spaceId} cannot be torn down by the bot — ${remediation(space)}`,
                detail
            );
        }
    }

    // `attention` is the source of truth for what is parked; the count is
    // derived from it once, so it cannot drift across guilds.
    summary.stuck = summary.attention.length;

    if (summary.swept || summary.failed || summary.stuck) {
        log.info('space_sweep', {
            swept: summary.swept,
            kicked: summary.kicked,
            failed: summary.failed,
            stuck: summary.stuck,
            guilds: summary.guilds,
        });
        mirrorToLedger('archivebot.space', 'expired spaces swept', summary);
    }
    return summary;
}

/**
 * Collect what a PAST teardown left behind.
 *
 * Spaces reaped before the cascade bug was found had their category and role
 * deleted but their `chat` and `Meeting Room` channels left alive. Those
 * records are already marked inactive, so the expiry sweep — which only reads
 * ACTIVE records — will never look at them again. Without this they sit in the
 * guild permanently.
 *
 * Safe by construction: it only touches ids this system RECORDED. It never
 * scans the guild for things that merely LOOK like a space, because "delete
 * every channel named chat" is not a mistake worth risking on a real server.
 *
 * Idempotent — anything already gone is skipped — so it can be re-run freely.
 */
async function repairOrphanedSpaces(discordClient) {
    const summary = { checked: 0, channels: 0, categories: 0, roles: 0, failed: 0 };

    for (const guildId of store.listGuildIds()) {
        let guild;
        try {
            guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
        } catch (err) {
            log.error('repair_guild_unreachable', err, { guildId });
            continue;
        }

        for (const space of store.load(guildId).spaces) {
            summary.checked++;
            const reason = `orphan repair ${space.spaceId}`;
            try {
                for (const childId of Array.isArray(space.channelIds) ? space.channelIds : []) {
                    const ch = await guild.channels.fetch(childId).catch(() => null);
                    if (ch) {
                        await ch.delete(reason);
                        summary.channels++;
                    }
                }
                const cat = await guild.channels.fetch(space.categoryId).catch(() => null);
                if (cat) {
                    await cat.delete(reason);
                    summary.categories++;
                }
                const role = await guild.roles.fetch(space.roleId).catch(() => null);
                if (role) {
                    await role.delete(reason);
                    summary.roles++;
                }
                if (space.active) store.markInactive(guildId, space.spaceId, { repaired: true });
            } catch (err) {
                summary.failed++;
                log.warn('repair_failed', { spaceId: space.spaceId, error: err.message });
            }
        }
    }

    log.info('space_repair', summary);
    return summary;
}

module.exports = {
    cacheGuildInvites,
    handleMemberAdd,
    resolveConsumedCode,
    teardownSpace,
    sweepExpiredSpaces,
    repairOrphanedSpaces,
    inviteCache,
};
