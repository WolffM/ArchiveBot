/**
 * Headless one-shot channel messages for the webhook server.
 *
 * `POST /api/messages/send` (see webhookServer.js) lands here after HMAC
 * verification. It exists because /api/events/create cannot express every
 * announcement: that route builds a Discord guild scheduled event and so hard-
 * requires a start and end time in the future. rally-api's ranked-choice polls
 * finish with a winner ("Pizza") that has no time attached at all, and the only
 * thing to do with it is say so in a channel.
 *
 * Deliberately narrow: the caller supplies the text and the target channel, and
 * that is all. Anything richer would widen what one leaked HMAC secret is
 * worth. Mentions in particular are suppressed outright — see allowedMentions
 * below — with one exception, `mentions` (next paragraph but one).
 *
 * The one widening is embeds, and only for callers the HTTP layer marks with
 * `allowEmbeds` (today: cardtable, whose patch notes do not fit 2000 chars of
 * plain text). Even then it is a validated subset — see validateEmbeds — with
 * no images, thumbnails, author icons or video, so an embed can only ever
 * display text the caller sent and one link.
 *
 * The same callers may name people to ping: `mentions` is a list of hadoku
 * names (cardtable's release notes credit whoever reported a bug as
 * `@name`). Each is looked up in the guild's linked accounts
 * (cardtableStore `links`, kept by cardtableMembers.js); a name that resolves
 * to exactly one Discord account has its `@name` tokens in `content` and in
 * every embed description rewritten to `<@id>`, and only those accounts are
 * let through allowedMentions. `parse` stays empty, so @everyone and roles can
 * never ping. A name that resolves to nothing, or to two accounts, stays as it
 * was typed: plain text, logged, never an error.
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
const cardtableStore = require('./cardtableStore');

const log = createLogger('messageWebhook');

// Same replay bound as the events routes: the HMAC scheme carries no nonce, so
// a stale signed body is refused and the idempotency key closes the window.
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

// Discord's own hard limit on message content.
const MAX_CONTENT_LENGTH = 2000;

// Discord's embed limits. Checked here rather than left to Discord: a
// too-long field is the caller's bug, and if Discord found it the caller would
// get a 500 and the ledger an alert for a message that was never deliverable.
const EMBED_LIMITS = {
    embeds: 10,
    title: 256,
    description: 4096,
    url: 2048,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footerText: 2048,
    // Across every embed in the message: titles, descriptions, field names
    // and values, footer text.
    totalChars: 6000,
};
const EMBED_KEYS = new Set(['title', 'description', 'url', 'color', 'fields', 'footer', 'timestamp']);
const FIELD_KEYS = new Set(['name', 'value', 'inline']);
const FOOTER_KEYS = new Set(['text']);

// How long a delivered message's idempotency key is remembered. Callers retry
// on the order of minutes (rally-api's cron sweep runs every 5), so days of
// memory is already far past the point where a retry could still arrive; the
// bound only stops the file growing without limit.
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const { OUTPUT_ROOT: OUTPUT_DIR } = require('./paths');

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

// How many people one message may name. Discord allows 100 user mentions; a
// release crediting more than this is a caller bug.
const MAX_MENTIONS = 25;
const MAX_MENTION_NAME = 64;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A non-blank string within the limit. */
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Validate an `embeds` array against the accepted subset and rebuild it from
 * the accepted keys only, so nothing unvalidated can ride along to Discord.
 *
 * Returns {ok: true, value} or {ok: false, detail} where detail names the
 * offending path ("embeds[0].image is not accepted") — a caller debugging a
 * 400 should not have to guess which of 25 fields it was.
 */
function validateEmbeds(embeds) {
    const fail = (detail) => ({ ok: false, detail });
    if (!Array.isArray(embeds) || embeds.length === 0 || embeds.length > EMBED_LIMITS.embeds) {
        return fail(`embeds must be an array of 1-${EMBED_LIMITS.embeds}`);
    }

    let totalChars = 0;
    const value = [];
    for (const [i, embed] of embeds.entries()) {
        const at = `embeds[${i}]`;
        if (!isPlainObject(embed)) return fail(`${at} must be an object`);
        const unknown = Object.keys(embed).find((k) => !EMBED_KEYS.has(k));
        if (unknown) return fail(`${at}.${unknown} is not accepted`);

        const out = {};
        if (embed.title !== undefined) {
            if (!isText(embed.title, EMBED_LIMITS.title)) return fail(`${at}.title must be 1-${EMBED_LIMITS.title} chars`);
            out.title = embed.title;
            totalChars += embed.title.length;
        }
        if (embed.description !== undefined) {
            if (!isText(embed.description, EMBED_LIMITS.description)) {
                return fail(`${at}.description must be 1-${EMBED_LIMITS.description} chars`);
            }
            out.description = embed.description;
            totalChars += embed.description.length;
        }
        if (embed.url !== undefined) {
            let parsed = null;
            try {
                parsed = typeof embed.url === 'string' && embed.url.length <= EMBED_LIMITS.url ? new URL(embed.url) : null;
            } catch {
                parsed = null;
            }
            if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
                return fail(`${at}.url must be an http(s) URL`);
            }
            out.url = embed.url;
        }
        if (embed.color !== undefined) {
            if (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff) {
                return fail(`${at}.color must be an integer 0-16777215`);
            }
            out.color = embed.color;
        }
        if (embed.fields !== undefined) {
            if (!Array.isArray(embed.fields) || embed.fields.length > EMBED_LIMITS.fields) {
                return fail(`${at}.fields must be an array of at most ${EMBED_LIMITS.fields}`);
            }
            out.fields = [];
            for (const [j, field] of embed.fields.entries()) {
                const fat = `${at}.fields[${j}]`;
                if (!isPlainObject(field)) return fail(`${fat} must be an object`);
                const unknownField = Object.keys(field).find((k) => !FIELD_KEYS.has(k));
                if (unknownField) return fail(`${fat}.${unknownField} is not accepted`);
                if (!isText(field.name, EMBED_LIMITS.fieldName)) return fail(`${fat}.name must be 1-${EMBED_LIMITS.fieldName} chars`);
                if (!isText(field.value, EMBED_LIMITS.fieldValue)) return fail(`${fat}.value must be 1-${EMBED_LIMITS.fieldValue} chars`);
                if (field.inline !== undefined && typeof field.inline !== 'boolean') return fail(`${fat}.inline must be a boolean`);
                out.fields.push({ name: field.name, value: field.value, ...(field.inline !== undefined ? { inline: field.inline } : {}) });
                totalChars += field.name.length + field.value.length;
            }
        }
        if (embed.footer !== undefined) {
            if (!isPlainObject(embed.footer)) return fail(`${at}.footer must be an object`);
            const unknownFooter = Object.keys(embed.footer).find((k) => !FOOTER_KEYS.has(k));
            if (unknownFooter) return fail(`${at}.footer.${unknownFooter} is not accepted`);
            if (!isText(embed.footer.text, EMBED_LIMITS.footerText)) {
                return fail(`${at}.footer.text must be 1-${EMBED_LIMITS.footerText} chars`);
            }
            out.footer = { text: embed.footer.text };
            totalChars += embed.footer.text.length;
        }
        if (embed.timestamp !== undefined) {
            const when = typeof embed.timestamp === 'string' ? new Date(embed.timestamp) : null;
            if (!when || Number.isNaN(when.getTime())) return fail(`${at}.timestamp must be an ISO 8601 string`);
            out.timestamp = when.toISOString();
        }
        // Discord rejects an embed with nothing to show. A url, colour or
        // timestamp on its own renders as an empty bar.
        if (!out.title && !out.description && !out.fields?.length) {
            return fail(`${at} needs a title, description or fields`);
        }
        value.push(out);
    }
    if (totalChars > EMBED_LIMITS.totalChars) {
        return fail(`embeds total ${totalChars} chars; the limit is ${EMBED_LIMITS.totalChars}`);
    }
    return { ok: true, value };
}

/**
 * Validate the payload shape. Returns {ok: true, value} or {ok: false, error}
 * with a machine-readable reason, matching validateEventPayload's contract,
 * plus a `detail` for embed refusals.
 *
 * `content` is optional when embeds are present, and required otherwise.
 */
function validateMessagePayload(payload, { allowEmbeds = false } = {}) {
    const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

    let mentions = null;
    if (payload.mentions !== undefined) {
        if (!allowEmbeds) return fail('mentions_not_permitted');
        const m = payload.mentions;
        if (!Array.isArray(m) || m.length === 0 || m.length > MAX_MENTIONS) {
            return fail('invalid_mentions', `mentions must be an array of 1-${MAX_MENTIONS}`);
        }
        for (const [i, name] of m.entries()) {
            if (!isText(name, MAX_MENTION_NAME)) {
                return fail('invalid_mentions', `mentions[${i}] must be a non-blank string of at most ${MAX_MENTION_NAME} chars`);
            }
        }
        mentions = m.map((name) => name.trim());
    }

    let embeds = null;
    if (payload.embeds !== undefined) {
        if (!allowEmbeds) return fail('embeds_not_permitted');
        const checked = validateEmbeds(payload.embeds);
        if (!checked.ok) return fail('invalid_embeds', checked.detail);
        embeds = checked.value;
    }

    const hasContent = payload.content !== undefined && payload.content !== '';
    if (hasContent || !embeds) {
        if (
            typeof payload.content !== 'string' ||
            !payload.content.trim() ||
            payload.content.length > MAX_CONTENT_LENGTH
        ) {
            return fail('invalid_content');
        }
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
            content: hasContent ? payload.content : null,
            embeds,
            mentions,
            idempotencyKey: payload.idempotencyKey.trim(),
            guildId: typeof payload.guild_id === 'string' ? payload.guild_id : null,
            channelId: typeof payload.channel_id === 'string' ? payload.channel_id : null,
        },
    };
}

/**
 * Each named person's Discord id, from the guild's linked accounts: the names
 * that match exactly one account (trimmed, case-insensitive), and the rest.
 */
function resolveMentions(names, links) {
    const byName = new Map();
    for (const [id, link] of Object.entries(links ?? {})) {
        if (typeof link?.name !== 'string') continue;
        const key = link.name.trim().toLowerCase();
        byName.set(key, byName.has(key) ? null : id);
    }
    const resolved = [];
    const unresolved = [];
    const seen = new Set();
    for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const id = byName.get(key);
        if (id) resolved.push({ name, id });
        else unresolved.push(name);
    }
    return { resolved, unresolved };
}

/**
 * The names `resolveMentions` left unresolved, looked up among the guild's members
 * by their Discord name: a name that is exactly (trimmed, case-insensitive) one
 * human member's username, display name or server nickname pings that member.
 * The operator, 2026-11-05: a reporter credited by their Discord name should be
 * pinged even before they link it. Two members answering to one name, a bot, or
 * a failed lookup leaves the name as typed. The guild-member search is REST and
 * needs no privileged intent.
 */
async function resolveByDiscordName(names, guild) {
    const resolved = [];
    const unresolved = [];
    for (const name of names) {
        const key = name.trim().toLowerCase();
        let found = [];
        try {
            const hits = guild?.members?.search ? await guild.members.search({ query: name.trim(), limit: 10 }) : null;
            found = [...(hits?.values?.() ?? [])].filter((m) => {
                if (m?.user?.bot) return false;
                const names = [m?.user?.username, m?.user?.globalName, m?.nickname];
                return names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === key);
            });
        } catch (err) {
            log.warn('mention_member_search_failed', { name, error: err?.message ?? String(err) });
        }
        if (found.length === 1) resolved.push({ name, id: found[0].user.id });
        else unresolved.push(name);
    }
    return { resolved, unresolved };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `@name` as a token: not inside a word or an email address before it, and not
 * running on into a longer name after it. A full stop that ends the sentence
 * ("Reported by @ohmusama.") still ends the token; one followed by more name
 * ("@ohmusama.alt") does not.
 */
function mentionToken(name) {
    return new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'gi');
}

/** Characters Discord counts toward an embed message's 6000. */
function embedChars(embeds) {
    let n = 0;
    for (const e of embeds) {
        n += (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0);
        for (const f of e.fields ?? []) n += f.name.length + f.value.length;
    }
    return n;
}

/**
 * `content` and embed descriptions with each resolved name's `@name` rewritten
 * to `<@id>`. A rewrite that would take a text past its limit is not made, so a
 * message that validated still sends: that person is named, not pinged.
 */
function applyMentions(input, resolved) {
    let content = input.content;
    const embeds = input.embeds ? input.embeds.map((e) => ({ ...e })) : null;
    const skipped = [];
    for (const { name, id } of resolved) {
        const token = mentionToken(name);
        if (content !== null) {
            const next = content.replace(token, `<@${id}>`);
            if (next.length <= MAX_CONTENT_LENGTH) content = next;
            else skipped.push(name);
        }
        for (const embed of embeds ?? []) {
            if (embed.description === undefined) continue;
            const was = embed.description;
            const next = was.replace(token, `<@${id}>`);
            if (next === was) continue;
            embed.description = next;
            if (next.length > EMBED_LIMITS.description || embedChars(embeds) > EMBED_LIMITS.totalChars) {
                embed.description = was;
                skipped.push(name);
            }
        }
    }
    return { content, embeds, skipped: [...new Set(skipped)] };
}

/** The text a message shows: its content and each embed's title and description. */
function shownText(content, embeds) {
    return JSON.stringify({
        content: content ?? '',
        embeds: (embeds ?? []).map((e) => ({ title: e.title ?? null, description: e.description ?? null })),
    });
}

/**
 * Change an already-posted message to this text, only when what it shows
 * differs (an edit marks a message "(edited)" in Discord, so an unchanged
 * re-send is a no-op). Mentions are applied the same way as a send.
 */
async function editPosted(channel, existing, { content, embeds, allowedMentions, mentionReport, source }) {
    let message;
    try {
        message = await channel.messages.fetch(existing.messageId);
    } catch (err) {
        log.info('message_edit_unknown', { messageId: existing.messageId, error: err?.message ?? String(err) });
        return { status: 404, body: { success: false, error: 'message_not_found' } };
    }
    const before = shownText(message.content, (message.embeds ?? []).map((e) => ({ title: e.title ?? e.data?.title, description: e.description ?? e.data?.description })));
    if (before === shownText(content, embeds)) {
        return { status: 200, body: { success: true, messageId: existing.messageId, unchanged: true, ...mentionReport } };
    }
    try {
        await message.edit({ content: content ?? '', ...(embeds ? { embeds } : {}), allowedMentions });
    } catch (err) {
        log.error('message_edit_failed', err, { messageId: existing.messageId, source });
        return { status: 500, body: { success: false, error: 'message_edit_failed' } };
    }
    log.success('message_edited', { messageId: existing.messageId, source });
    return { status: 200, body: { success: true, messageId: existing.messageId, edited: true, ...mentionReport } };
}

/**
 * Post the message (or report the already-posted one for a repeated
 * idempotency key). Returns { status, body } for the HTTP layer.
 */
async function handleMessageSend(payload, discordClient, { allowEmbeds = false, edit = false } = {}) {
    const validated = validateMessagePayload(payload, { allowEmbeds });
    if (!validated.ok) {
        const detail = validated.detail ? { detail: validated.detail } : {};
        log.fail('message_refused', { error: validated.error, ...detail, source: payload.source ?? 'unknown' });
        return { status: 400, body: { success: false, error: validated.error, ...detail } };
    }
    const input = validated.value;

    const guildId = input.guildId || process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    let channelId = input.channelId || process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
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
    // An edit changes a message this route posted, under the same key, and
    // never posts: a key it has no record of (never sent, or past the TTL) is
    // refused, so a late edit can never repost an old announcement.
    if (edit && !existing?.messageId) {
        log.info('message_edit_unknown', { idempotencyKey: input.idempotencyKey });
        return { status: 404, body: { success: false, error: 'message_not_found' } };
    }
    if (edit) channelId = existing.channelId ?? channelId;
    if (existing && !edit) {
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

    let content = input.content;
    let embeds = input.embeds;
    let mentionReport = {};
    const allowedMentions = { parse: [] };
    if (input.mentions) {
        const linked = resolveMentions(input.mentions, cardtableStore.getLinks(guildId));
        const guild = channel.guild ?? discordClient.guilds?.cache?.get(guildId) ?? null;
        const byName = linked.unresolved.length > 0 ? await resolveByDiscordName(linked.unresolved, guild) : { resolved: [], unresolved: [] };
        const resolved = [...linked.resolved, ...byName.resolved];
        const unresolved = byName.unresolved;
        const applied = applyMentions(input, resolved);
        content = applied.content;
        embeds = applied.embeds;
        if (resolved.length > 0) allowedMentions.users = resolved.map((r) => r.id);
        if (unresolved.length > 0 || applied.skipped.length > 0) {
            log.info('mentions_not_pinged', { unresolved, tooLong: applied.skipped, source: payload.source ?? 'unknown' });
        }
        mentionReport = { mentioned: resolved.map((r) => r.name), unresolved };
    }

    if (edit) return editPosted(channel, existing, { content, embeds, allowedMentions, mentionReport, source: payload.source ?? 'unknown' });

    let sent;
    try {
        sent = await channel.send({
            ...(content !== null ? { content } : {}),
            ...(embeds ? { embeds } : {}),
            // The text is composed by the caller from user-supplied material —
            // rally-api builds it out of a poll's title and winning option, both
            // typed by whoever made the poll. Without this, naming a poll
            // "@everyone dinner" turns a webhook into a guild-wide ping. The
            // only users let through are the ones `mentions` resolved.
            allowedMentions,
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

    return { status: 200, body: { success: true, messageId, ...mentionReport } };
}

module.exports = {
    handleMessageSend,
    validateMessagePayload,
    validateEmbeds,
    resolveMentions,
    resolveByDiscordName,
    mentionToken,
    EMBED_LIMITS,
    MAX_MENTIONS,
    MAX_TIMESTAMP_SKEW_MS,
    MAX_CONTENT_LENGTH,
    SENT_TTL_MS,
};
