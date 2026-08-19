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
 *
 * `POST /api/events/update` (handleEventsUpdate) moves or cancels an event this
 * route already created. meet-api needs it because an organizer can REOPEN a
 * closed event and close it again on a different winning time: without an edit
 * path the only options are a duplicate guild event at the new time or a stale
 * one at the old, and both leave the calendar lying.
 *
 * `POST /api/events/channels` (handleEventsChannels) lists the text channels
 * of the configured guild so a caller can offer the operator a channel picker.
 */

const {
    ChannelType,
    GuildScheduledEventEntityType,
    GuildScheduledEventPrivacyLevel,
    PermissionsBitField,
} = require('discord.js');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger, mirrorFailureToLedger } = require('./ledger');
const scheduler = require('./scheduler');

const log = createLogger('eventWebhook');

// Reject requests whose signed timestamp is stale — the HMAC scheme has no
// nonce, so this bounds the replay window (the idempotency key then closes it).
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

// Upper bound on the reminder lead time. Nothing needs a year of warning, and
// an absurd value would only produce an item that sits active in the store
// until someone notices it.
const MAX_REMIND_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

// How many threads any one parent may contribute to the channel picker, taken
// most-recent-first. A forum with hundreds of posts would otherwise bury every
// plain channel in the list and make the picker useless.
const MAX_THREADS_PER_PARENT = 25;

/**
 * Parse the optional advance-warning lead time, shared by create and update.
 *
 * Rejected rather than ignored when malformed: buildEventReminderMessage feeds
 * this straight to formatRelativeTime, so a bad value does not fail here — it
 * ships a reminder reading "starts in NaNs" hours later, with no way back.
 *
 * Returns {ok: true, value: number|null} or {ok: false}.
 */
function parseRemindBefore(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (
        typeof raw !== 'number' ||
        !Number.isFinite(raw) ||
        raw <= 0 ||
        raw > MAX_REMIND_BEFORE_MS
    ) {
        return { ok: false };
    }
    return { ok: true, value: raw };
}

/**
 * Validate the signed-request envelope every route here shares: an idempotency
 * key to dedupe on, and a timestamp recent enough that a captured body cannot
 * be replayed later. Returns null when fine, or a machine-readable reason.
 */
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

/**
 * Validate the payload shape. Returns {ok: true, value} with parsed dates or
 * {ok: false, error} with a machine-readable reason.
 */
function validateEventPayload(payload) {
    const fail = error => ({ ok: false, error });

    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 100) {
        return fail('invalid_name');
    }
    const envelope = validateEnvelope(payload);
    if (envelope) return fail(envelope);

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

    const remind = parseRemindBefore(payload.remindBeforeMs);
    if (!remind.ok) return fail('invalid_remind_before');
    const remindBeforeMs = remind.value;

    return {
        ok: true,
        value: {
            name: payload.name.trim(),
            idempotencyKey: payload.idempotencyKey.trim(),
            start,
            end,
            description,
            location,
            remindBeforeMs,
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
        // 50035 is excluded on purpose: Discord rejecting the payload is the
        // caller's bug, answered with a 400, and belongs in meet's logs rather
        // than in this bot's alert stream.
        if (err.code !== 50035) {
            mirrorFailureToLedger('archivebot.event', 'event not created', {
                source: payload.source ?? 'unknown',
                guildId,
                eventName: input.name,
                error: err,
            });
        }
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
    const createdDate = new Date().toISOString();
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
        createdDate,
        lastTriggered: null,
        active: true,
        sourceKey: input.idempotencyKey,
        description: input.description ?? null,
        location: input.location,
    });

    // Companion advance-warning item. The `type: 'event'` item above only fires
    // AT the start time, which is too late to act on — the reminder people
    // actually read is this second item, exactly as /event builds it when given
    // `remind_before` (scheduler.js handleEventCommand). Without one, a
    // webhook-created event gets a bare "**Event:** <name>" as it begins.
    let reminderCreated = false;
    if (input.remindBeforeMs !== null) {
        const remindAt = new Date(input.start.getTime() - input.remindBeforeMs);
        // Voting can close inside the lead-time window, so the reminder may
        // already be due. Dropped rather than fired: a past triggerAt would go
        // out on the very next 60s tick, announcing an event that "starts in"
        // a time already spent.
        if (remindAt.getTime() > Date.now()) {
            fresh.items.push({
                id: scheduler.getNextItemId(fresh),
                type: 'event_reminder',
                guildId,
                channelId,
                creatorId: discordClient.user.id,
                scheduledEventId: scheduledEvent.id,
                eventName: input.name,
                remindBeforeMs: input.remindBeforeMs,
                triggerAt: remindAt.toISOString(),
                recurring: null,
                createdDate,
                lastTriggered: null,
                active: true,
                sourceKey: input.idempotencyKey,
            });
            reminderCreated = true;
        } else {
            log.info('event_reminder_skipped', {
                reason: 'lead time already passed',
                idempotencyKey: input.idempotencyKey,
                remindAt: remindAt.toISOString(),
            });
        }
    }

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
        reminderCreated,
    });

    return {
        status: 200,
        body: {
            success: true,
            eventId: scheduledEvent.id,
            url: scheduledEvent.url ?? null,
            reminderCreated,
        },
    };
}

/**
 * List the text channels of the configured guild that the bot can actually
 * post in, so a caller can offer a channel picker.
 *
 * Read-only, so there is no idempotency key — but it keeps the signed-timestamp
 * staleness check, since a captured request would otherwise stay replayable
 * forever.
 *
 * The guild is taken from ARCHIVEBOT_EVENT_GUILD_ID and deliberately NOT from
 * the payload: accepting a caller-supplied guild would turn one leaked HMAC
 * secret into a channel-enumeration oracle for every guild the bot is in.
 *
 * Returns { status, body } for the HTTP layer.
 */
async function handleEventsChannels(payload, discordClient) {
    if (
        typeof payload.timestamp !== 'number' ||
        Math.abs(Date.now() - payload.timestamp) > MAX_TIMESTAMP_SKEW_MS
    ) {
        return { status: 400, body: { success: false, error: 'stale_timestamp' } };
    }

    const guildId = process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    if (!guildId) {
        log.error('event_target_not_configured', null, { hasGuild: false });
        return { status: 500, body: { success: false, error: 'event_target_not_configured' } };
    }

    let guild;
    try {
        guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
    } catch (err) {
        log.error('guild_not_found', err, { guildId });
        return { status: 500, body: { success: false, error: 'guild_not_found' } };
    }

    let me;
    try {
        me = guild.members.me || (await guild.members.fetchMe());
    } catch (err) {
        log.error('bot_member_not_resolvable', err, { guildId });
        return { status: 500, body: { success: false, error: 'bot_member_not_resolvable' } };
    }

    // Channels the bot can both see and post in. Filtering on send permission
    // is not cosmetic: fireItem calls channel.send with no isTextBased guard,
    // so handing back an unpostable channel converts a pickable option into a
    // reminder that throws on its trigger tick and retries forever.
    //
    // Threads count. The guild's long-running event announcements live in one
    // ("party gamers" is a type-11 public thread), so a text-channels-only list
    // would omit the single most likely pick. Voice and category channels stay
    // out: a category has no send at all, and a voice channel's text tab is not
    // where anyone looks for this.
    const POSTABLE_TYPES = new Set([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
    ]);

    /** Picker entry for a channel the bot can post in, or null if it can't. */
    const entryFor = (channel) => {
        if (!POSTABLE_TYPES.has(channel.type)) return null;
        // Threads resolve permissions through their parent, and a locked one
        // rejects sends from everyone but moderators.
        const isThread = typeof channel.isThread === 'function' && channel.isThread();
        if (isThread && channel.locked) return null;
        const perms = channel.permissionsFor(me);
        // Posting in a thread is gated by SendMessagesInThreads, NOT
        // SendMessages — a bot can hold one without the other.
        const required = [
            PermissionsBitField.Flags.ViewChannel,
            isThread
                ? PermissionsBitField.Flags.SendMessagesInThreads
                : PermissionsBitField.Flags.SendMessages,
        ];
        if (!perms || !perms.has(required)) return null;
        return {
            id: channel.id,
            name: channel.name,
            // For a thread this is the channel it hangs off, which is exactly
            // the grouping a picker wants.
            parentName: channel.parent?.name ?? null,
        };
    };

    const channels = [];
    const seen = new Set();
    const threadCountByParent = new Map();

    const add = (channel) => {
        if (seen.has(channel.id)) return;
        const entry = entryFor(channel);
        if (!entry) return;
        if (typeof channel.isThread === 'function' && channel.isThread()) {
            const key = channel.parentId ?? '';
            const used = threadCountByParent.get(key) ?? 0;
            if (used >= MAX_THREADS_PER_PARENT) return;
            threadCountByParent.set(key, used + 1);
        }
        seen.add(channel.id);
        channels.push(entry);
    };

    // Cache first. It holds the plain channels plus every ACTIVE thread, and
    // an active thread is by definition more recent than an archived one, so
    // it should claim the per-parent budget before anything archived does.
    for (const channel of guild.channels.cache.values()) add(channel);

    // Then the archived posts. Only active threads reach the cache, so a busy
    // forum previously showed just its handful of un-archived posts. Archived
    // is not the same as unavailable: posting to an archived thread that isn't
    // locked silently unarchives it, so those posts are genuinely pickable and
    // leaving them out hid most of the forum.
    //
    // Bounded to forum and media channels — posts accumulate there, whereas
    // doing this for all ~95 guild channels would mean ~95 rate-limited API
    // calls every time someone opens the picker.
    const postParents = guild.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia
    );
    for (const parent of postParents.values()) {
        if ((threadCountByParent.get(parent.id) ?? 0) >= MAX_THREADS_PER_PARENT) continue;
        try {
            // Discord returns these newest-archived first, so the slice that
            // the per-parent budget takes is the most recent one.
            const { threads } = await parent.threads.fetchArchived({
                type: 'public',
                limit: MAX_THREADS_PER_PARENT,
            });
            for (const thread of threads.values()) add(thread);
        } catch (err) {
            // One unreadable forum must not cost the caller the entire list.
            log.warn('archived_threads_fetch_failed', {
                parentId: parent.id,
                error: err?.message ?? String(err),
            });
        }
    }

    // Category-then-name, so the picker reads like the Discord sidebar. Note
    // this is display order only — WHICH threads survive the per-parent cap is
    // decided by recency above, not alphabetically.
    channels.sort(
        (a, b) =>
            (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.name.localeCompare(b.name)
    );

    log.info('channels_listed', {
        guildId,
        count: channels.length,
        threadCount: [...threadCountByParent.values()].reduce((a, b) => a + b, 0),
        source: payload.source ?? 'unknown',
    });
    return { status: 200, body: { success: true, channels } };
}


/**
 * Validate an update payload. `cancel: true` needs nothing but the envelope
 * and the event id; anything else is a reschedule and carries the same fields
 * a create does.
 */
function validateEventUpdatePayload(payload) {
    const fail = (error) => ({ ok: false, error });

    const envelope = validateEnvelope(payload);
    if (envelope) return fail(envelope);

    if (typeof payload.scheduledEventId !== 'string' || !payload.scheduledEventId.trim()) {
        return fail('missing_scheduled_event_id');
    }

    const base = {
        idempotencyKey: payload.idempotencyKey.trim(),
        scheduledEventId: payload.scheduledEventId.trim(),
        guildId: typeof payload.guild_id === 'string' ? payload.guild_id : null,
        channelId: typeof payload.channel_id === 'string' ? payload.channel_id : null,
    };

    if (payload.cancel === true) {
        return { ok: true, value: { ...base, cancel: true } };
    }

    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 100) {
        return fail('invalid_name');
    }
    const start = new Date(payload.startTime);
    const end = new Date(payload.endTime);
    if (Number.isNaN(start.getTime())) return fail('invalid_start_time');
    if (Number.isNaN(end.getTime())) return fail('invalid_end_time');
    if (end <= start) return fail('end_not_after_start');
    // Same rule as create: Discord refuses to hold an event in the past, and a
    // reschedule that lands there is a caller bug, not something to paper over.
    if (start.getTime() <= Date.now()) return fail('start_in_past');

    const remind = parseRemindBefore(payload.remindBeforeMs);
    if (!remind.ok) return fail('invalid_remind_before');

    return {
        ok: true,
        value: {
            ...base,
            cancel: false,
            name: payload.name.trim(),
            start,
            end,
            description:
                typeof payload.description === 'string'
                    ? payload.description.slice(0, 1000)
                    : undefined,
            location:
                typeof payload.location === 'string' && payload.location.trim()
                    ? payload.location.slice(0, 100)
                    : payload.name.slice(0, 100),
            remindBeforeMs: remind.value,
        },
    };
}

/**
 * Move or cancel a scheduled event this route created earlier.
 *
 * The caller owns the event id (meet-api stores it when create returns), so
 * this does not dedupe by re-deriving one — it edits in place and records the
 * update's idempotency key on the item, which is what makes a retried POST a
 * no-op instead of a second edit.
 *
 * A cancel deletes the guild event and deactivates BOTH tracked items — the
 * start-time announcement and its companion reminder. Leaving either behind is
 * how a cancelled event still announces itself an hour later.
 *
 * Returns { status, body } for the HTTP layer. 404 means the caller's id no
 * longer names anything this bot is tracking; meet-api treats that as "create
 * a fresh one" rather than an error.
 */
async function handleEventsUpdate(payload, discordClient) {
    const validated = validateEventUpdatePayload(payload);
    if (!validated.ok) {
        return { status: 400, body: { success: false, error: validated.error } };
    }
    const input = validated.value;

    const guildId = input.guildId || process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    if (!guildId) {
        log.error('event_target_not_configured', null, { hasGuild: false });
        return { status: 500, body: { success: false, error: 'event_target_not_configured' } };
    }

    let guild;
    try {
        guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
    } catch (err) {
        log.error('guild_not_found', err, { guildId });
        return { status: 500, body: { success: false, error: 'guild_not_found' } };
    }

    // A re-target is optional, but when one is supplied it gets the same
    // cross-guild guard create applies: fireItem fetches channels globally and
    // would happily announce into another guild.
    if (input.channelId) {
        try {
            const channel = await discordClient.channels.fetch(input.channelId);
            if (!channel || channel.guildId !== guildId) {
                log.error('channel_not_in_guild', null, { channelId: input.channelId, guildId });
                return { status: 500, body: { success: false, error: 'channel_not_in_guild' } };
            }
        } catch (err) {
            log.error('channel_not_found', err, { channelId: input.channelId });
            return { status: 500, body: { success: false, error: 'channel_not_found' } };
        }
    }

    const data = scheduler.loadScheduledItems(guildId);
    const tracked = data.items.filter(
        (item) => item.scheduledEventId === input.scheduledEventId && item.active
    );
    const anchor = tracked.find((item) => item.type === 'event') ?? tracked[0];
    if (!anchor) {
        log.info('event_update_untracked', { scheduledEventId: input.scheduledEventId });
        return { status: 404, body: { success: false, error: 'event_not_tracked' } };
    }

    // Retry guard. The caller's cron re-pushes a failed close, so the same
    // update can legitimately arrive twice; applying it twice would be
    // harmless for the edit but would delete twice for a cancel.
    if (anchor.lastUpdateKey === input.idempotencyKey) {
        log.info('event_update_deduped', {
            idempotencyKey: input.idempotencyKey,
            scheduledEventId: input.scheduledEventId,
        });
        return {
            status: 200,
            body: { success: true, eventId: input.scheduledEventId, deduped: true },
        };
    }

    let scheduledEvent;
    try {
        scheduledEvent = await guild.scheduledEvents.fetch(input.scheduledEventId);
    } catch (err) {
        // 10070 = Unknown Guild Scheduled Event. Someone deleted it in Discord;
        // the items tracking it are now pointing at nothing, so retire them.
        log.info('event_update_gone', { scheduledEventId: input.scheduledEventId, code: err?.code });
        for (const item of tracked) item.active = false;
        scheduler.saveScheduledItems(guildId, data);
        return { status: 404, body: { success: false, error: 'event_not_found' } };
    }

    if (input.cancel) {
        try {
            await scheduledEvent.delete();
        } catch (err) {
            log.error('event_cancel_failed', err, { scheduledEventId: input.scheduledEventId });
            // Worse than a failed create: the calendar keeps claiming a time
            // nobody agreed to, and its reminder is still armed.
            mirrorFailureToLedger('archivebot.event', 'event not cancelled', {
                source: payload.source ?? 'unknown',
                guildId,
                eventId: input.scheduledEventId,
                eventName: anchor.eventName,
                error: err,
            });
            return { status: 500, body: { success: false, error: 'event_cancel_failed' } };
        }
        for (const item of tracked) {
            item.active = false;
            item.lastUpdateKey = input.idempotencyKey;
        }
        scheduler.saveScheduledItems(guildId, data);

        mirrorToLedger('archivebot.event', `event cancelled: ${anchor.eventName}`, {
            source: payload.source ?? 'unknown',
            eventId: input.scheduledEventId,
        });
        log.success('event_cancelled', {
            eventId: input.scheduledEventId,
            source: payload.source ?? 'unknown',
        });
        return { status: 200, body: { success: true, eventId: input.scheduledEventId, cancelled: true } };
    }

    try {
        await scheduledEvent.edit({
            name: input.name,
            scheduledStartTime: input.start,
            scheduledEndTime: input.end,
            entityMetadata: { location: input.location },
            description: input.description,
        });
    } catch (err) {
        // Same rule as create: everything but Discord rejecting the payload,
        // which is the caller's bug and is answered with a 400. A move that
        // does not land leaves the old time on the calendar, still reminding.
        if (err.code !== 50035) {
            mirrorFailureToLedger('archivebot.event', 'event not updated', {
                source: payload.source ?? 'unknown',
                guildId,
                eventId: input.scheduledEventId,
                eventName: input.name,
                error: err,
            });
        }
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
        log.error('event_update_failed', err, { guildId, name: input.name });
        return { status: 500, body: { success: false, error: 'event_update_failed' } };
    }

    const channelId = input.channelId || anchor.channelId;
    const startItem = tracked.find((item) => item.type === 'event') ?? null;
    if (startItem) {
        startItem.eventName = input.name;
        startItem.triggerAt = input.start.toISOString();
        startItem.channelId = channelId;
        startItem.description = input.description ?? null;
        startItem.location = input.location;
        // The move puts the trigger back in the future, so a tick that already
        // fired this item must be allowed to fire the new time.
        startItem.lastTriggered = null;
        startItem.lastUpdateKey = input.idempotencyKey;
    }

    // Re-point the companion reminder. Three outcomes, and the one that is easy
    // to miss is the third: a reschedule that moves the event INSIDE its own
    // lead time leaves no room for an advance warning, and an item whose
    // triggerAt is already past would go out on the very next 60s tick
    // announcing an event that "starts in" a time already spent.
    let reminder = tracked.find((item) => item.type === 'event_reminder') ?? null;
    let reminderActive = false;
    const remindAt =
        input.remindBeforeMs === null ? null : new Date(input.start.getTime() - input.remindBeforeMs);

    if (remindAt && remindAt.getTime() > Date.now()) {
        if (!reminder) {
            reminder = {
                id: scheduler.getNextItemId(data),
                type: 'event_reminder',
                guildId,
                creatorId: discordClient.user.id,
                scheduledEventId: input.scheduledEventId,
                recurring: null,
                createdDate: new Date().toISOString(),
                active: true,
            };
            data.items.push(reminder);
        }
        reminder.eventName = input.name;
        reminder.channelId = channelId;
        reminder.remindBeforeMs = input.remindBeforeMs;
        reminder.triggerAt = remindAt.toISOString();
        reminder.lastTriggered = null;
        reminder.active = true;
        reminder.lastUpdateKey = input.idempotencyKey;
        reminderActive = true;
    } else if (reminder) {
        reminder.active = false;
        reminder.lastUpdateKey = input.idempotencyKey;
    }

    scheduler.saveScheduledItems(guildId, data);

    mirrorToLedger('archivebot.event', `event updated: ${input.name}`, {
        source: payload.source ?? 'unknown',
        eventId: input.scheduledEventId,
        startTime: input.start.toISOString(),
    });
    log.success('event_updated', {
        eventId: input.scheduledEventId,
        name: input.name,
        source: payload.source ?? 'unknown',
        reminderActive,
    });

    return {
        status: 200,
        body: {
            success: true,
            eventId: input.scheduledEventId,
            url: scheduledEvent.url ?? null,
            reminderActive,
        },
    };
}

module.exports = {
    handleEventsCreate,
    handleEventsUpdate,
    handleEventsChannels,
    validateEventPayload,
    validateEventUpdatePayload,
    MAX_TIMESTAMP_SKEW_MS,
    MAX_REMIND_BEFORE_MS,
};
