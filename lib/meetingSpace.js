/**
 * Private, disposable meeting spaces.
 *
 * A "space" is one guest's isolated corner of the guild: a category holding a
 * `chat` text channel and a `Meeting Room` voice channel, plus a role that is
 * the only thing (besides the owner) permitted to see them. The guest gets a
 * single-use invite; joining through it assigns them the role.
 *
 * Generic on purpose. contact-api is the first caller, but nothing here knows
 * what a "booking" is — a caller supplies a label and a TTL and gets a space.
 *
 * ## Why a category rather than two loose channels
 *
 * Permissions are set ONCE on the category and both channels inherit. Deleting
 * the category deletes its children, so teardown is one call that cannot half-
 * succeed and leave an orphaned voice channel nobody can see.
 *
 * ## Naming is deliberately opaque
 *
 * A channel hidden from @everyone is genuinely hidden, but ROLE NAMES are not:
 * they surface in mention autocomplete and the member list. A role named for
 * the guest would publish "who booked" to the whole guild, which is exactly
 * what the isolation is meant to prevent. Every generated name is a random
 * token; the human label lives only in the returned metadata and in the
 * package store, both of which stay server-side.
 *
 * ## Ceilings this has to respect
 *
 * A guild caps at 500 channels and 250 roles. Each space costs 3 channels
 * (category + 2) and 1 role, so ~166 concurrent spaces before the channel
 * ceiling bites. `sweepExpiredSpaces` is therefore load-bearing, not
 * housekeeping: if it stops running, provisioning starts failing. It reports
 * what it reaped so a silent stall is visible.
 *
 * ## The owner sees everything for free
 *
 * The guild owner bypasses channel overwrites, so no explicit grant is needed
 * or made. If this is ever used in a guild where the operator is NOT the
 * owner, that assumption has to change — hence `ownerBypassAssumed` in the
 * returned metadata rather than a silent dependency.
 */

const {
    ChannelType,
    PermissionsBitField,
    OverwriteType,
} = require('discord.js');
const crypto = require('crypto');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger, mirrorFailureToLedger } = require('./ledger');
const store = require('./meetingSpaceStore');

const log = createLogger('meetingSpace');

/** Matches the events webhook: bounds replay when the HMAC carries no nonce. */
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

/** Default lifetime when a caller does not specify one. */
const DEFAULT_TTL_MS = 8 * 24 * 60 * 60 * 1000;

/** A month is already absurd for a disposable space; refuse more. */
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

/** Discord's own ceilings, checked before we add to them. */
const GUILD_CHANNEL_LIMIT = 500;
const GUILD_ROLE_LIMIT = 250;

/** Headroom kept free so a full guild fails HERE with a clear error rather
 *  than half-provisioning and leaving a category with no channels in it. */
const CHANNELS_PER_SPACE = 3;
const ROLES_PER_SPACE = 1;

/**
 * An opaque, collision-resistant token. Base36 over 64 bits of CSPRNG — long
 * enough that two spaces never collide, short enough to read in a channel list.
 */
function spaceToken() {
    const bytes = crypto.randomBytes(8);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

function validateEnvelope(payload) {
    if (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey.trim()) {
        return 'missing_idempotency_key';
    }
    if (
        typeof payload.timestamp !== 'number' ||
        Math.abs(Date.now() - payload.timestamp) > MAX_TIMESTAMP_SKEW_MS
    ) {
        return 'stale_timestamp';
    }
    return null;
}

function validateProvisionPayload(payload) {
    const fail = (error) => ({ ok: false, error });

    const envelope = validateEnvelope(payload);
    if (envelope) return fail(envelope);

    // `label` is for the operator's eyes only — it is stored, never used as a
    // Discord name. See the naming note in the module comment.
    if (typeof payload.label !== 'string' || !payload.label.trim() || payload.label.length > 200) {
        return fail('invalid_label');
    }

    let ttlMs = DEFAULT_TTL_MS;
    if (payload.ttlMs !== undefined) {
        if (typeof payload.ttlMs !== 'number' || !Number.isFinite(payload.ttlMs) || payload.ttlMs <= 0) {
            return fail('invalid_ttl');
        }
        if (payload.ttlMs > MAX_TTL_MS) return fail('ttl_too_long');
        ttlMs = payload.ttlMs;
    }

    return {
        ok: true,
        value: {
            idempotencyKey: payload.idempotencyKey.trim(),
            label: payload.label.trim(),
            ttlMs,
            guildId: typeof payload.guild_id === 'string' ? payload.guild_id : null,
            source: typeof payload.source === 'string' ? payload.source.slice(0, 40) : 'unknown',
        },
    };
}

/**
 * Provision a space. Idempotent on `idempotencyKey`: a replayed POST returns
 * the space already created rather than a second one, because a retry after a
 * slow response must not double-charge the guild's channel budget.
 */
async function handleSpaceProvision(payload, discordClient) {
    const validated = validateProvisionPayload(payload);
    if (!validated.ok) {
        return { status: 400, body: { success: false, error: validated.error } };
    }
    const input = validated.value;

    const guildId = input.guildId || process.env.ARCHIVEBOT_SPACE_GUILD_ID || process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    if (!guildId) {
        log.error('space_guild_not_configured', null, {});
        return { status: 500, body: { success: false, error: 'space_guild_not_configured' } };
    }

    let guild;
    try {
        guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
    } catch (err) {
        log.error('guild_not_found', err, { guildId });
        return { status: 500, body: { success: false, error: 'guild_not_found' } };
    }

    const existing = store.findByIdempotencyKey(guildId, input.idempotencyKey);
    if (existing && existing.active) {
        log.info('space_deduped', { idempotencyKey: input.idempotencyKey, spaceId: existing.spaceId });
        return {
            status: 200,
            body: {
                success: true,
                deduped: true,
                spaceId: existing.spaceId,
                inviteUrl: existing.inviteUrl,
                categoryId: existing.categoryId,
                roleId: existing.roleId,
                expiresAt: existing.expiresAt,
            },
        };
    }

    // Refuse BEFORE creating anything. Discord answers a 500-ish error partway
    // through otherwise, and a half-built space is worse than no space.
    const capacity = await checkCapacity(guild);
    if (!capacity.ok) {
        log.error('guild_at_capacity', null, capacity.detail);
        return { status: 507, body: { success: false, error: 'guild_at_capacity', detail: capacity.detail } };
    }

    const token = spaceToken();
    const created = { role: null, category: null, channels: [], invite: null };

    try {
        // Role first: the category's overwrites reference it.
        created.role = await guild.roles.create({
            name: `space-${token}`,
            mentionable: false,
            reason: `meeting space ${token} (${input.source})`,
        });

        created.category = await guild.channels.create({
            name: `space-${token}`,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    type: OverwriteType.Role,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: created.role.id,
                    type: OverwriteType.Role,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.Connect,
                        PermissionsBitField.Flags.Speak,
                    ],
                },
                // THE BOT MUST GRANT ITSELF ACCESS, or it locks itself out of
                // the category it just built. Denying @everyone ViewChannel
                // denies the bot too — guild-level MANAGE_CHANNELS does not
                // rescue that, because Discord refuses to manage a channel you
                // cannot see. Found end-to-end: provisioning succeeded and
                // every revoke then failed with `Missing Access`, leaving a
                // category nothing could delete and which still charged the
                // 500-channel ceiling. Unless the bot holds Administrator (it
                // should not need to), this overwrite is what makes teardown
                // possible at all.
                {
                    id: discordClient.user.id,
                    type: OverwriteType.Member,
                    // ViewChannel + ManageChannels ONLY. ManageRoles was here
                    // and made every provision fail 50013: Discord refuses an
                    // overwrite that grants MANAGE_ROLES unless the setter
                    // holds it in that channel, which is circular when the
                    // channel is being created. It is also unnecessary —
                    // deleting a category needs MANAGE_CHANNELS and the
                    // ability to SEE it, nothing more. The two together are the
                    // minimum that makes teardown possible.
                    //
                    // SendMessages and Connect were also listed, contradicting
                    // the sentence above — and a comment asserting a minimum
                    // while the code grants more reads as a reviewed decision
                    // when it is not one.
                    //
                    // Removing them is a provable no-op, which is the only
                    // reason to touch a permission list that already works: the
                    // @everyone overwrite denies ViewChannel and NOTHING ELSE,
                    // so those two were never taken away and allowing them back
                    // restored nothing. ViewChannel is the single permission
                    // this overwrite has to restore; ManageChannels is kept
                    // deliberately, so teardown does not depend on the bot's
                    // guild role still carrying it. The same reasoning is why
                    // creating the invite works with no CreateInstantInvite
                    // here — an allow only ADDS to what the guild roles grant.
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.ManageChannels,
                    ],
                },
            ],
            reason: `meeting space ${token} (${input.source})`,
        });

        // Both children inherit the category's overwrites by omitting their own.
        const chat = await guild.channels.create({
            name: 'chat',
            type: ChannelType.GuildText,
            parent: created.category.id,
            reason: `meeting space ${token}`,
        });
        created.channels.push(chat);

        const room = await guild.channels.create({
            name: 'Meeting Room',
            type: ChannelType.GuildVoice,
            parent: created.category.id,
            reason: `meeting space ${token}`,
        });
        created.channels.push(room);

        // maxUses:1 is the second half of the invite→role binding: the tracker
        // matches on use count, and a reusable invite would make two joiners
        // indistinguishable. maxAge 0 = never expires on Discord's side; the
        // sweep owns expiry so there is one clock, not two.
        created.invite = await chat.createInvite({
            maxUses: 1,
            maxAge: 0,
            unique: true,
            reason: `meeting space ${token}`,
        });
    } catch (err) {
        // Unwind whatever landed. A partially built space consumes the guild's
        // channel budget forever and is invisible to the sweep, which only
        // knows about spaces that made it into the store.
        log.error('space_provision_failed', err, { guildId, token });
        await rollback(created, token);
        mirrorFailureToLedger('archivebot.space', 'space not provisioned', {
            source: input.source,
            guildId,
            error: err,
        });
        if (err.code === 50013) {
            return { status: 500, body: { success: false, error: 'missing_permissions' } };
        }
        return { status: 500, body: { success: false, error: 'space_provision_failed' } };
    }

    const now = Date.now();
    const record = {
        spaceId: token,
        idempotencyKey: input.idempotencyKey,
        label: input.label,
        source: input.source,
        guildId,
        roleId: created.role.id,
        categoryId: created.category.id,
        channelIds: created.channels.map((c) => c.id),
        inviteCode: created.invite.code,
        inviteUrl: created.invite.url,
        memberId: null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.ttlMs).toISOString(),
        active: true,
    };
    store.upsert(guildId, record);

    log.info('space_provisioned', { spaceId: token, source: input.source, expiresAt: record.expiresAt });
    mirrorToLedger('archivebot.space', 'space provisioned', {
        source: input.source,
        guildId,
        spaceId: token,
    });

    return {
        status: 200,
        body: {
            success: true,
            spaceId: token,
            inviteUrl: record.inviteUrl,
            categoryId: record.categoryId,
            roleId: record.roleId,
            expiresAt: record.expiresAt,
            ownerBypassAssumed: true,
        },
    };
}

/** Would one more space exceed a Discord ceiling? Checked before building. */
async function checkCapacity(guild) {
    const channels = guild.channels.cache.size;
    const roles = guild.roles.cache.size;
    const detail = {
        channels,
        channelLimit: GUILD_CHANNEL_LIMIT,
        roles,
        roleLimit: GUILD_ROLE_LIMIT,
    };
    if (channels + CHANNELS_PER_SPACE > GUILD_CHANNEL_LIMIT) return { ok: false, detail };
    if (roles + ROLES_PER_SPACE > GUILD_ROLE_LIMIT) return { ok: false, detail };
    return { ok: true, detail };
}

/** Best-effort unwind of a partially provisioned space. Never throws. */
async function rollback(created, token) {
    for (const channel of created.channels) {
        await channel.delete(`rollback ${token}`).catch(() => {});
    }
    if (created.category) await created.category.delete(`rollback ${token}`).catch(() => {});
    if (created.role) await created.role.delete(`rollback ${token}`).catch(() => {});
}

/**
 * Tear a space down early — a cancelled booking, an operator revoking access.
 * Same teardown the sweep performs, just triggered rather than timed, so the
 * two paths cannot drift into cleaning up differently.
 */
async function handleSpaceRevoke(payload, discordClient) {
    const envelope = validateEnvelope(payload);
    if (envelope) return { status: 400, body: { success: false, error: envelope } };

    const spaceId = typeof payload.spaceId === 'string' ? payload.spaceId.trim() : '';
    if (!spaceId) return { status: 400, body: { success: false, error: 'missing_space_id' } };

    const guildId =
        (typeof payload.guild_id === 'string' ? payload.guild_id : null) ||
        process.env.ARCHIVEBOT_SPACE_GUILD_ID ||
        process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    if (!guildId) return { status: 500, body: { success: false, error: 'space_guild_not_configured' } };

    const space = store.findBySpaceId(guildId, spaceId);
    if (!space) return { status: 404, body: { success: false, error: 'space_not_found' } };
    // Already torn down: answer success. A caller retrying a revoke must not
    // get an error for a job that is already done.
    if (!space.active) return { status: 200, body: { success: true, alreadyInactive: true, spaceId } };

    let guild;
    try {
        guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
    } catch (err) {
        log.error('guild_not_found', err, { guildId });
        return { status: 500, body: { success: false, error: 'guild_not_found' } };
    }

    // Required lazily: the reaper requires this module for nothing, but keeping
    // the import at call time documents that teardown lives there, once.
    const { teardownSpace } = require('./meetingSpaceReaper');
    const outcome = await teardownSpace(guild, space);
    if (!outcome.deleted) {
        return { status: 500, body: { success: false, error: 'space_teardown_failed', detail: outcome.errors } };
    }
    return { status: 200, body: { success: true, spaceId, kicked: outcome.kicked } };
}

/**
 * The reaper as an HTTP handler, so expiry is driven by the fleet cron rather
 * than an in-process timer. A timer dies silently on an unhandled rejection or
 * a restart and is discovered at the channel ceiling; a cron job that stops
 * reporting is a FAILED JobExecution that pages.
 *
 * Answers 500 when a teardown failed and will be retried, for exactly that
 * reason — a sweep that quietly returns 200 having deleted nothing is the
 * failure mode this whole design is trying to avoid.
 *
 * A `stuck` space does NOT fail the job, and that is not a softening of the
 * above. A space the bot can never delete failed this endpoint every 60
 * seconds forever, which does not summon an operator — it trains everyone to
 * ignore the alarm, and the next genuine stall arrives into a job that has
 * been red for a week. It is alerted once on the way in, reported in
 * `attention` with the exact channel and role to remove, and then kept quiet.
 */
async function handleSpaceSweep(payload, discordClient) {
    const envelope = validateEnvelope(payload);
    if (envelope) return { status: 400, body: { success: false, error: envelope } };

    const { sweepExpiredSpaces } = require('./meetingSpaceReaper');
    const summary = await sweepExpiredSpaces(discordClient);
    if (summary.failed > 0) {
        return { status: 500, body: { success: false, error: 'sweep_incomplete', ...summary } };
    }
    return { status: 200, body: { success: true, ...summary } };
}

module.exports = {
    handleSpaceProvision,
    handleSpaceRevoke,
    handleSpaceSweep,
    validateProvisionPayload,
    spaceToken,
    checkCapacity,
    DEFAULT_TTL_MS,
    MAX_TTL_MS,
    GUILD_CHANNEL_LIMIT,
    GUILD_ROLE_LIMIT,
};
