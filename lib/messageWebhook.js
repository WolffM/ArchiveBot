/**
 * Headless one-shot channel messages for the webhook server.
 *
 * `POST /api/messages/send` (see webhookServer.js) lands here after HMAC
 * verification. It exists because /api/events/create cannot express every
 * announcement: that route builds a Discord guild scheduled event and so hard-
 * requires a start and end time in the future. meet-api's ranked-choice polls
 * finish with a winner ("Pizza") that has no time attached at all, and the only
 * thing to do with it is say so in a channel.
 *
 * Deliberately narrow: the caller supplies the text and the target channel, and
 * that is all. Anything richer (embeds, components, mentions) would widen what
 * one leaked HMAC secret is worth. Mentions in particular are suppressed
 * outright — see allowedMentions below.
 *
 * Guild/channel resolution mirrors eventWebhook.js: the payload may carry
 * guild_id / channel_id, otherwise ARCHIVEBOT_EVENT_GUILD_ID /
 * ARCHIVEBOT_EVENT_CHANNEL_ID supply the defaults, and the channel must belong
 * to the resolved guild.
 */

const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger, mirrorFailureToLedger } = require('./ledger');

const log = createLogger('messageWebhook');

// Same replay bound as the events routes: the HMAC scheme carries no nonce, so
// a stale signed body is refused and the idempotency key closes the window.
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

// Discord's own hard limit on message content.
const MAX_CONTENT_LENGTH = 2000;

// How long a delivered message's idempotency key is remembered. Callers retry
// on the order of minutes (meet-api's cron sweep runs every 5), so days of
// memory is already far past the point where a retry could still arrive; the
// bound only stops the file growing without limit.
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OUTPUT_DIR = path.join(__dirname, '..', 'Output');

/**
 * Delivery record store, one file per guild.
 *
 * Separate from the scheduler's scheduled.json on purpose: everything in there
 * is a *pending* item the 60s tick walks and may fire. A message that has
 * already been sent is the opposite — a fact about the past, with nothing left
 * to trigger — and parking it in that file would put entries in front of the
 * tick that it has no type for.
 */
function sentFilePath(guildId) {
    return path.join(OUTPUT_DIR, guildId, 'sentMessages.json');
}

function loadSent(guildId) {
    const filePath = sentFilePath(guildId);
    if (!fs.existsSync(filePath)) return { sent: [] };
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data.sent) ? data : { sent: [] };
    } catch (err) {
        // A corrupt store must not wedge announcements. Losing the memory risks
        // one duplicate message; refusing to send risks silence forever.
        log.warn('sent_store_unreadable', { guildId, error: err?.message ?? String(err) });
        return { sent: [] };
    }
}

function saveSent(guildId, data) {
    helper.ensureDirectoryExists(path.join(OUTPUT_DIR, guildId));
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(sentFilePath(guildId), JSON.stringify(data, null, 2));
}

/**
 * Validate the payload shape. Returns {ok: true, value} or {ok: false, error}
 * with a machine-readable reason, matching validateEventPayload's contract.
 */
function validateMessagePayload(payload) {
    const fail = (error) => ({ ok: false, error });

    if (
        typeof payload.content !== 'string' ||
        !payload.content.trim() ||
        payload.content.length > MAX_CONTENT_LENGTH
    ) {
        return fail('invalid_content');
    }
    if (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey.trim()) {
        return fail('missing_idempotency_key');
    }
    if (
        typeof payload.timestamp !== 'number' ||
        Math.abs(Date.now() - payload.timestamp) > MAX_TIMESTAMP_SKEW_MS
    ) {
        return fail('stale_timestamp');
    }

    return {
        ok: true,
        value: {
            content: payload.content,
            idempotencyKey: payload.idempotencyKey.trim(),
            guildId: typeof payload.guild_id === 'string' ? payload.guild_id : null,
            channelId: typeof payload.channel_id === 'string' ? payload.channel_id : null,
        },
    };
}

/**
 * Post the message (or report the already-posted one for a repeated
 * idempotency key). Returns { status, body } for the HTTP layer.
 */
async function handleMessageSend(payload, discordClient) {
    const validated = validateMessagePayload(payload);
    if (!validated.ok) {
        return { status: 400, body: { success: false, error: validated.error } };
    }
    const input = validated.value;

    const guildId = input.guildId || process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    const channelId = input.channelId || process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
    if (!guildId || !channelId) {
        log.error('message_target_not_configured', null, {
            hasGuild: !!guildId,
            hasChannel: !!channelId,
        });
        return { status: 500, body: { success: false, error: 'message_target_not_configured' } };
    }

    // Idempotency first: a replayed POST, or a caller retrying after a slow
    // response, must not post the same announcement twice.
    const store = loadSent(guildId);
    const existing = store.sent.find((entry) => entry.key === input.idempotencyKey);
    if (existing) {
        log.info('message_deduped', {
            idempotencyKey: input.idempotencyKey,
            messageId: existing.messageId,
        });
        return {
            status: 200,
            body: { success: true, messageId: existing.messageId, deduped: true },
        };
    }

    let channel;
    try {
        channel = await discordClient.channels.fetch(channelId);
    } catch (err) {
        log.error('channel_not_found', err, { channelId });
        return { status: 500, body: { success: false, error: 'channel_not_found' } };
    }
    if (!channel) {
        log.error('channel_not_found', null, { channelId });
        return { status: 500, body: { success: false, error: 'channel_not_found' } };
    }
    // Channels are fetched globally, so a wrong id would happily post into a
    // different guild the bot happens to be in.
    if (channel.guildId !== guildId) {
        log.error('channel_not_in_guild', null, { channelId, guildId });
        return { status: 500, body: { success: false, error: 'channel_not_in_guild' } };
    }
    if (typeof channel.send !== 'function') {
        log.error('channel_not_sendable', null, { channelId });
        return { status: 500, body: { success: false, error: 'channel_not_sendable' } };
    }

    let sent;
    try {
        sent = await channel.send({
            content: input.content,
            // The text is composed by the caller from user-supplied material —
            // meet-api builds it out of a poll's title and winning option, both
            // typed by whoever made the poll. Without this, naming a poll
            // "@everyone dinner" turns a webhook into a guild-wide ping.
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        // One mirror covering all three: a caller asked for a message, got a
        // 5xx, and nothing reached the channel. Which Discord code caused it is
        // detail for the row, not a reason to alert three different ways.
        const reason =
            err.code === 50013
                ? 'missing_send_permission'
                : err.status === 429
                  ? 'discord_rate_limited'
                  : 'message_send_failed';
        mirrorFailureToLedger('archivebot.message', 'message not delivered', {
            source: payload.source ?? 'unknown',
            channelId,
            reason,
            error: err
        });
        if (err.code === 50013) {
            log.error('missing_send_permission', err, { channelId });
            return { status: 500, body: { success: false, error: 'missing_send_permission' } };
        }
        if (err.status === 429) {
            log.error('discord_rate_limited', err, { channelId });
            return { status: 503, body: { success: false, error: 'discord_rate_limited' } };
        }
        log.error('message_send_failed', err, { channelId });
        return { status: 500, body: { success: false, error: 'message_send_failed' } };
    }

    const messageId = sent?.id ?? null;

    // Record the delivery, dropping anything past the TTL while we hold the
    // file. Reloaded rather than reusing `store` to keep the read-modify-write
    // window small — the store has no locking, same as the scheduler's.
    const fresh = loadSent(guildId);
    const cutoff = Date.now() - SENT_TTL_MS;
    fresh.sent = fresh.sent.filter((entry) => (entry.sentAt ?? 0) > cutoff);
    fresh.sent.push({
        key: input.idempotencyKey,
        messageId,
        channelId,
        sentAt: Date.now(),
        source: payload.source ?? 'unknown',
    });
    saveSent(guildId, fresh);

    mirrorToLedger('archivebot.message', 'message posted', {
        source: payload.source ?? 'unknown',
        channelId,
        messageId,
    });
    log.success('message_posted', {
        messageId,
        channelId,
        source: payload.source ?? 'unknown',
    });

    return { status: 200, body: { success: true, messageId } };
}

module.exports = {
    handleMessageSend,
    validateMessagePayload,
    MAX_TIMESTAMP_SKEW_MS,
    MAX_CONTENT_LENGTH,
    SENT_TTL_MS,
};
