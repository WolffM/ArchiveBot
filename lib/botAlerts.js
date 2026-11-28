'use strict';

/**
 * Tell a guild's admins, in Discord, what the bot could not do.
 *
 * Two things report here:
 *
 *   reportFailure          every notification somebody was owed that did not
 *                          go out. It still mirrors to monitoring-api's ledger
 *                          (lib/ledger.js) and now also posts in Discord.
 *   checkGuildPermissions  the bot's guild permissions against the canonical
 *                          list (lib/botPermissions.js), at ready, on joining a
 *                          guild, when one of its roles or its own member
 *                          changes, and after any 50013.
 *
 * ## Where an alert goes
 *
 * The guild's #bot-alerts: the one `/setup layout:cardtable` recorded, else any
 * text channel of that name (so another guild opts in by creating one). When
 * there is none, or it refuses the post, the alert is a DM to the guild owner.
 *
 * The permission check only POSTS in a guild that asked for alerts: the bound
 * cardtable guild, or one with a #bot-alerts. Elsewhere a shortfall is logged
 * and not sent. It runs on every start in every guild, and the bot is in
 * guilds whose owners invited it with less on purpose; DMing them after each
 * deploy would be nagging, not alerting. A failed notification is different:
 * something somebody was owed did not happen, so it reaches the owner anywhere.
 *
 * ## Never in the way
 *
 * Every entry point resolves, never rejects, and callers fire it and forget
 * it: an alert must not delay or fail the request whose failure it reports.
 * An alert that cannot be delivered is logged at ERROR as
 * `event=bot_alert_undelivered`, never dropped silently.
 *
 * ## Throttle
 *
 * One alert per guild and kind an hour, recorded in `bot-alerts.json` under
 * the output root, so a 10-minute retry loop sends one message and a restart
 * does not reset the clock (the file is state: lib/stateSync.js syncs it). A
 * passing permission check clears its stamp, so the next shortfall is told at
 * once rather than up to an hour late.
 */

const fs = require('fs');
const { createLogger } = require('../utils/logger');
const { outputPath } = require('./paths');
const { mirrorFailureToLedger } = require('./ledger');
const store = require('./cardtableStore');
const { missingPermissions, reauthorizeUrl } = require('./botPermissions');

const log = createLogger('botAlerts');

const THROTTLE_MS = 60 * 60 * 1000;
const CHANNEL_NAME = 'bot-alerts';
const PERMISSIONS_KIND = 'permissions';
// Missing Permissions, Missing Access: both can be a guild permission the bot lacks.
const PERMISSION_CODES = new Set([50013, 50001]);

let discordClient = null;

/** Hand the module the logged-in client. Called once, from index.js. */
function init(client) {
    discordClient = client;
}

function stampsFile() {
    return outputPath('bot-alerts.json');
}

function loadStamps() {
    try {
        return JSON.parse(fs.readFileSync(stampsFile(), 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') log.warn('bot_alert_stamps_unreadable', { error: err.message });
        return {};
    }
}

function saveStamps(stamps) {
    const file = stampsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stamps, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * Take the hour's slot for `key`, or say it is taken. The stamp is written
 * before the send, so two failures in the same tick send one message.
 */
function claim(key, now = Date.now()) {
    const stamps = loadStamps();
    if (stamps[key] !== undefined && now - stamps[key] < THROTTLE_MS) return false;
    for (const [k, at] of Object.entries(stamps)) if (now - at >= THROTTLE_MS) delete stamps[k];
    stamps[key] = now;
    saveStamps(stamps);
    return true;
}

function release(key) {
    const stamps = loadStamps();
    if (stamps[key] === undefined) return;
    delete stamps[key];
    saveStamps(stamps);
}

function clientId() {
    return process.env.CLIENT_ID || discordClient?.application?.id || discordClient?.user?.id || null;
}

function describeError(error) {
    if (error === undefined || error === null) return null;
    const text = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error.code !== undefined ? ` (${error.code})` : '';
    return `${text}${code}`.slice(0, 300);
}

/** The fix line for a shortfall: what to grant, and the one link that grants it. */
function permissionFix(missing, guildId) {
    const link = reauthorizeUrl(clientId(), guildId);
    const names = missing.map((p) => p.label).join(', ');
    return link
        ? `grant ${names}. Re-authorise me here, which adds them to my role: <${link}>`
        : `grant ${names} to my role.`;
}

function formatAlert({ what, source, error, fix }) {
    const lines = [`**ArchiveBot: ${what}**`];
    if (source) lines.push(`Caller: ${source}`);
    const err = describeError(error);
    if (err) lines.push(`Discord error: ${err}`);
    if (fix) lines.push(`Fix: ${fix}`);
    return lines.join('\n').slice(0, 2000);
}

function alertChannel(guild) {
    const recorded = store.getSetup(guild.id)?.channels?.botAlerts;
    const byId = recorded && guild.channels.cache.get(recorded);
    if (byId) return byId;
    return (
        guild.channels.cache.find(
            (c) => c.name === CHANNEL_NAME && typeof c.send === 'function' && !c.isThread?.()
        ) ?? null
    );
}

/** Whether the permission check may post in this guild, not only log. */
function wantsAlerts(guild) {
    return store.getSetup(guild.id) !== null || alertChannel(guild) !== null;
}

/** Post to #bot-alerts, else DM the owner. Returns 'channel', 'dm' or null. */
async function deliver(guild, content) {
    const channel = alertChannel(guild);
    if (channel) {
        try {
            await channel.send({ content });
            return 'channel';
        } catch (err) {
            log.warn('bot_alert_channel_refused', { guildId: guild.id, channelId: channel.id, error: describeError(err) });
        }
    }
    try {
        const owner = await guild.fetchOwner();
        await owner.send({ content });
        return 'dm';
    } catch (err) {
        log.warn('bot_alert_dm_refused', { guildId: guild.id, ownerId: guild.ownerId, error: describeError(err) });
        return null;
    }
}

async function resolveGuild(guildId) {
    return discordClient.guilds.cache.get(guildId) ?? (await discordClient.guilds.fetch(guildId));
}

/**
 * Send one alert to a guild, throttled per guild and kind. Resolves to
 * `{ sent, via?, reason? }`; never rejects.
 */
async function alert({ guild, guildId, kind, what, source, error, fix }) {
    const id = guild?.id ?? guildId;
    try {
        if (!discordClient && !guild) {
            log.error('bot_alert_undelivered', null, { guildId: id, kind, reason: 'no_client' });
            return { sent: false, reason: 'no_client' };
        }
        const target = guild ?? (await resolveGuild(id));
        const key = `${id}:${kind}`;
        if (!claim(key)) {
            log.info('bot_alert_throttled', { guildId: id, kind });
            return { sent: false, reason: 'throttled' };
        }
        const via = await deliver(target, formatAlert({ what, source, error, fix }));
        if (!via) {
            log.error('bot_alert_undelivered', null, { guildId: id, kind, reason: 'no_destination' });
            return { sent: false, reason: 'no_destination' };
        }
        log.info('bot_alert_sent', { guildId: id, kind, via });
        return { sent: true, via };
    } catch (err) {
        log.error('bot_alert_failed', err, { guildId: id, kind });
        return { sent: false, reason: 'error' };
    }
}

async function botMember(guild) {
    return guild.members.me ?? (await guild.members.fetchMe());
}

/**
 * Compare the bot's guild permissions with the canonical list. Resolves to the
 * missing entries (empty when complete), or null when the check itself failed.
 */
async function checkGuildPermissions(guild, { trigger } = {}) {
    try {
        const missing = missingPermissions(await botMember(guild));
        const key = `${guild.id}:${PERMISSIONS_KIND}`;
        if (missing.length === 0) {
            release(key);
            log.debug('bot_permissions_ok', { guildId: guild.id, trigger });
            return missing;
        }
        log.warn('bot_permissions_missing', {
            guildId: guild.id,
            missing: missing.map((p) => p.name).join(','),
            trigger,
        });
        if (wantsAlerts(guild)) {
            await alert({
                guild,
                kind: PERMISSIONS_KIND,
                what: 'missing server permissions',
                fix: permissionFix(missing, guild.id),
            });
        }
        return missing;
    } catch (err) {
        log.error('bot_permission_check_failed', err, { guildId: guild?.id, trigger });
        return null;
    }
}

async function notifyFailure(name, message, context) {
    const { guildId, source, error } = context;
    try {
        if (!guildId) {
            log.error('bot_alert_undelivered', null, { kind: name, reason: 'no_guild' });
            return { sent: false, reason: 'no_guild' };
        }
        let fix = null;
        if (error && PERMISSION_CODES.has(error.code) && discordClient) {
            // The check that runs after a 50013: its answer is this alert's fix.
            const guild = await resolveGuild(guildId);
            const missing = missingPermissions(await botMember(guild));
            fix = missing.length
                ? permissionFix(missing, guildId)
                : "my server permissions are complete, so a channel's own permission overwrites are refusing me.";
        }
        return await alert({ guildId, kind: `${name}:${message}`, what: message, source, error, fix });
    } catch (err) {
        log.error('bot_alert_failed', err, { guildId, kind: name });
        return { sent: false, reason: 'error' };
    }
}

/**
 * A notification somebody was owed did not go out: mirror it to the ledger
 * and tell the guild. Fire and forget; the returned promise never rejects and
 * exists for tests. `context.guildId` routes the alert, `context.source` names
 * the caller and `context.error` is the Discord error.
 */
function reportFailure(name, message, context = {}) {
    mirrorFailureToLedger(name, message, context);
    return notifyFailure(name, message, context);
}

module.exports = {
    init,
    alert,
    deliver,
    reportFailure,
    checkGuildPermissions,
    formatAlert,
    THROTTLE_MS,
    CHANNEL_NAME,
};
