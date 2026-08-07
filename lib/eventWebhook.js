/**
 * Headless Discord scheduled-event creation for the webhook server.
 *
 * `POST /api/events/create` (see webhookServer.js) lands here after HMAC
 * verification. The flow mirrors the /event slash command's external-event
 * path (scheduler.js handleEventCommand) without any interaction coupling:
 * validate → dedupe on idempotency key → guild.scheduledEvents.create →
 * track the item in the scheduler store so the 60s tick announces it like
 * any command-created event.
 *
 * Guild/channel resolution: the payload may carry guild_id / channel_id;
 * otherwise the ARCHIVEBOT_EVENT_GUILD_ID / ARCHIVEBOT_EVENT_CHANNEL_ID env
 * vars (vault-provisioned via the PM2 wrapper) supply the defaults. The
 * channel must belong to the guild — fireItem posts via a global channel
 * fetch and would happily announce cross-guild otherwise.
 */

const {
    GuildScheduledEventEntityType,
    GuildScheduledEventPrivacyLevel,
} = require('discord.js');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger } = require('./ledger');
const scheduler = require('./scheduler');

const log = createLogger('eventWebhook');

// Reject requests whose signed timestamp is stale — the HMAC scheme has no
// nonce, so this bounds the replay window (the idempotency key then closes it).
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

/**
 * Validate the payload shape. Returns {ok: true, value} with parsed dates or
 * {ok: false, error} with a machine-readable reason.
 */
function validateEventPayload(payload) {
    const fail = error => ({ ok: false, error });

    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 100) {
        return fail('invalid_name');
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

    const start = new Date(payload.startTime);
    const end = new Date(payload.endTime);
    if (Number.isNaN(start.getTime())) return fail('invalid_start_time');
    if (Number.isNaN(end.getTime())) return fail('invalid_end_time');
    if (end <= start) return fail('end_not_after_start');
    if (start.getTime() <= Date.now()) return fail('start_in_past');

    const description =
        typeof payload.description === 'string' ? payload.description.slice(0, 1000) : undefined;
    const location =
        typeof payload.location === 'string' && payload.location.trim()
            ? payload.location.slice(0, 100)
            : payload.name.slice(0, 100);

    return {
        ok: true,
        value: {
            name: payload.name.trim(),
            idempotencyKey: payload.idempotencyKey.trim(),
            start,
            end,
            description,
            location,
            guildId: typeof payload.guild_id === 'string' ? payload.guild_id : null,
            channelId: typeof payload.channel_id === 'string' ? payload.channel_id : null,
        },
    };
}

/**
 * Create the scheduled event (or return the already-created one for a
 * repeated idempotency key). Returns { status, body } for the HTTP layer.
 */
async function handleEventsCreate(payload, discordClient) {
    const validated = validateEventPayload(payload);
    if (!validated.ok) {
        return { status: 400, body: { success: false, error: validated.error } };
    }
    const input = validated.value;

    const guildId = input.guildId || process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    const channelId = input.channelId || process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
    if (!guildId || !channelId) {
        log.error('event_target_not_configured', null, { hasGuild: !!guildId, hasChannel: !!channelId });
        return { status: 500, body: { success: false, error: 'event_target_not_configured' } };
    }

    let guild;
    try {
        guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
    } catch (err) {
        log.error('guild_not_found', err, { guildId });
        return { status: 500, body: { success: false, error: 'guild_not_found' } };
    }

    // Announce channel must belong to the target guild (fireItem fetches
    // channels globally, so a wrong id would post into another guild).
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || channel.guildId !== guildId) {
            log.error('channel_not_in_guild', null, { channelId, guildId });
            return { status: 500, body: { success: false, error: 'channel_not_in_guild' } };
        }
    } catch (err) {
        log.error('channel_not_found', err, { channelId });
        return { status: 500, body: { success: false, error: 'channel_not_found' } };
    }

    // Idempotency: a replayed POST (or a caller retry after a slow response)
    // must not create a duplicate Discord event.
    const data = scheduler.loadScheduledItems(guildId);
    const existing = data.items.find(item => item.sourceKey === input.idempotencyKey && item.active);
    if (existing) {
        log.info('event_deduped', { idempotencyKey: input.idempotencyKey, id: existing.scheduledEventId });
        return {
            status: 200,
            body: { success: true, eventId: existing.scheduledEventId, deduped: true },
        };
    }

    let scheduledEvent;
    try {
        scheduledEvent = await guild.scheduledEvents.create({
            name: input.name,
            scheduledStartTime: input.start,
            scheduledEndTime: input.end,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: input.location },
            description: input.description,
        });
    } catch (err) {
        if (err.code === 50013) {
            log.error('missing_manage_events_permission', err, { guildId });
            return { status: 500, body: { success: false, error: 'missing_manage_events_permission' } };
        }
        if (err.code === 50035) {
            log.error('discord_rejected_event', err, { name: input.name });
            return { status: 400, body: { success: false, error: 'discord_rejected_event' } };
        }
        if (err.status === 429) {
            log.error('discord_rate_limited', err, { guildId });
            return { status: 503, body: { success: false, error: 'discord_rate_limited' } };
        }
        log.error('event_create_failed', err, { guildId, name: input.name });
        return { status: 500, body: { success: false, error: 'event_create_failed' } };
    }

    // Track in the scheduler store so the 60s tick announces it at start time,
    // exactly like a command-created event. Reload to keep the read-modify-
    // write window as small as possible (the store has no locking).
    const fresh = scheduler.loadScheduledItems(guildId);
    fresh.items.push({
        id: scheduler.getNextItemId(fresh),
        type: 'event',
        guildId,
        channelId,
        creatorId: discordClient.user.id,
        scheduledEventId: scheduledEvent.id,
        eventName: input.name,
        triggerAt: input.start.toISOString(),
        recurring: null,
        createdDate: new Date().toISOString(),
        lastTriggered: null,
        active: true,
        sourceKey: input.idempotencyKey,
        description: input.description ?? null,
        location: input.location,
    });
    scheduler.saveScheduledItems(guildId, fresh);

    mirrorToLedger('archivebot.event', `event created: ${input.name}`, {
        source: payload.source ?? 'unknown',
        eventId: scheduledEvent.id,
        startTime: input.start.toISOString(),
    });
    log.success('event_created', {
        eventId: scheduledEvent.id,
        name: input.name,
        source: payload.source ?? 'unknown',
    });

    return {
        status: 200,
        body: { success: true, eventId: scheduledEvent.id, url: scheduledEvent.url ?? null },
    };
}

module.exports = { handleEventsCreate, validateEventPayload, MAX_TIMESTAMP_SKEW_MS };
