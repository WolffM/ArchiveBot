/**
 * `GET /api/messages/recent` (see webhookServer.js) lands here after the HMAC
 * check and the cardtable guild scope. It feeds hadoku-cardtable's front page:
 * a snapshot of the last few messages in the cardtable guild's #general, shown
 * to friend-tier viewers beside a Join Discord button (hadoku-cardtable
 * docs/requests/ARCHIVEBOT_RECENT_MESSAGES.md, issue #37).
 *
 * The answer leaves Discord for a web page, so it carries plain text and
 * nothing that identifies or links back: an author's display name, the text,
 * and when. Every `<…>` markup token Discord stores is resolved to the name it
 * shows, or to a placeholder when the name is not known — a mention we cannot
 * resolve must not leak the id it carries. URLs become `[link]` and spoilers
 * `[spoiler]`, since the page cannot click through or hide either.
 *
 * Only #general, the channel `/setup cardtable` recorded. `channel=` exists so
 * the contract can grow, but any value other than `general` is refused.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('recentMessages');

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_TEXT = 200;
// Discord's own ceiling on one fetch. Bot, system and attachment-only
// messages are skipped, so ask for more than the limit to still fill it.
const FETCH_WINDOW = 100;

/** `?channel=general&limit=5` → { limit } or { error }. */
function parseQuery(query) {
    const params = new URLSearchParams(query);
    const channel = params.get('channel') ?? 'general';
    if (channel !== 'general') return { error: 'channel_not_permitted' };
    const rawLimit = params.get('limit');
    if (rawLimit === null) return { limit: DEFAULT_LIMIT };
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) return { error: 'invalid_limit' };
    return { limit: Math.min(Number(rawLimit), MAX_LIMIT) };
}

function userName(message, id) {
    const name =
        message.mentions?.members?.get(id)?.displayName ??
        message.mentions?.users?.get(id)?.displayName ??
        message.guild?.members?.cache?.get(id)?.displayName;
    return name ? `@${name}` : '@someone';
}

function roleName(message, id) {
    const name = message.mentions?.roles?.get(id)?.name ?? message.guild?.roles?.cache?.get(id)?.name;
    return name ? `@${name}` : '@role';
}

function channelName(message, id) {
    const name = message.mentions?.channels?.get(id)?.name ?? message.guild?.channels?.cache?.get(id)?.name;
    return name ? `#${name}` : '#channel';
}

/** Codepoint-safe cut, so an emoji is never split into a lone surrogate. */
function truncate(text, max) {
    const chars = Array.from(text);
    return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** A message's content as plain text with no ids or links in it. */
function plainText(message) {
    return truncate(
        (message.content ?? '')
            .replace(/\|\|[\s\S]+?\|\|/g, '[spoiler]')
            .replace(/<?https?:\/\/[^\s<>]+>?/g, '[link]')
            .replace(/<@!?(\d+)>/g, (_, id) => userName(message, id))
            .replace(/<@&(\d+)>/g, (_, id) => roleName(message, id))
            .replace(/<#(\d+)>/g, (_, id) => channelName(message, id))
            .replace(/<a?:(\w+):\d+>/g, ':$1:')
            .replace(/<\/([^:>]+):\d+>/g, '/$1')
            .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, s) => new Date(Number(s) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
            .replace(/\s+/g, ' ')
            .trim(),
        MAX_TEXT
    );
}

function authorName(message) {
    return message.member?.displayName ?? message.author?.displayName ?? message.author?.username ?? 'someone';
}

/**
 * @param {string} query            the raw query string, without the `?`
 * @param {import('discord.js').Client} discordClient
 * @param {{ guildId: string, generalChannelId: string|undefined }} scope
 * @returns {Promise<{ status: number, body: object }>}
 */
async function handleRecentMessages(query, discordClient, { guildId, generalChannelId }) {
    const parsed = parseQuery(query);
    if (parsed.error) {
        log.fail('recent_messages_refused', { error: parsed.error });
        return { status: 400, body: { success: false, error: parsed.error } };
    }
    if (!generalChannelId) {
        // A setup from before #general was recorded. Ours to fix by re-running
        // /setup cardtable, not the caller's.
        log.error('cardtable_general_not_set_up', null, { guildId });
        return { status: 503, body: { success: false, error: 'cardtable_general_not_set_up' } };
    }

    const channel = await discordClient.channels.fetch(generalChannelId).catch((err) => {
        log.error('recent_messages_channel_fetch', err, { channelId: generalChannelId });
        return null;
    });
    // The guild check is belt and braces: the id came from the bound guild's
    // own setup, but a hand-edited file must not turn this into a reader of
    // any channel the bot can see.
    if (!channel || channel.guildId !== guildId || !channel.messages) {
        log.error('cardtable_general_unavailable', null, { guildId, channelId: generalChannelId });
        return { status: 503, body: { success: false, error: 'cardtable_general_unavailable' } };
    }

    const fetched = await channel.messages.fetch({ limit: FETCH_WINDOW });
    const newestFirst = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const messages = [];
    for (const message of newestFirst) {
        if (messages.length >= parsed.limit) break;
        if (message.system || message.author?.bot) continue;
        const text = plainText(message);
        if (!text) continue;
        messages.push({
            author: authorName(message),
            text,
            at: new Date(message.createdTimestamp).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        });
    }
    messages.reverse();
    log.debug('recent_messages_served', { count: messages.length, limit: parsed.limit });
    return { status: 200, body: { messages } };
}

module.exports = { handleRecentMessages, plainText, parseQuery, MAX_LIMIT, MAX_TEXT };
