/**
 * The weekly archive of every guild the bot is in.
 *
 * Archiving used to be opt-in: a guild was archived only if someone had set a
 * weekly reminder carrying `action: archive_server`, so three of the bot's six
 * guilds never were. Now this sweep archives every guild in the client's cache
 * once a week, including guilds joined since the last run, and a guild the bot
 * joins is archived at once (its first run pulls its whole history).
 *
 * The old reminders are retired at start (`retireArchiveReminders`): the
 * channel each one posted in becomes that guild's status channel, and the item
 * is deactivated, so the guild is not archived twice. A guild with no status
 * channel gets no messages at all; its progress is only logged.
 *
 * Every run of a guild — the sweep, a join, /archiveserver — goes through one
 * queue, so no guild is ever archived by two runs at once.
 *
 * State lives in `<output root>/archive-sweep.json` (lib/stateSync.js carries it
 * to the store, so a standby taking over knows when the last sweep was):
 *   lastRun         ISO time the last sweep finished
 *   guilds          guild ids that sweep archived, to name one that drops out
 *   statusChannels  { guildId: channelId } where progress is posted
 */
const fs = require('fs');
const { outputPath } = require('./paths');
const archive = require('./archive');
const { createLogger } = require('../utils/logger');

const log = createLogger('archiveSweep');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const RETIRED_ACTION = 'archive_server';

let client = null;
let timers = [];
let stopped = true;
let sweeping = false;
let queue = Promise.resolve();
let archiveFn = archive.archiveServer;

function statePath() {
    return outputPath('archive-sweep.json');
}

function loadState() {
    const file = statePath();
    if (!fs.existsSync(file)) return { lastRun: null, guilds: [], statusChannels: {} };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastRun: null, guilds: [], statusChannels: {}, ...state };
}

function saveState(state) {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function isDue(state, now = Date.now(), intervalMs = WEEK_MS) {
    if (!state.lastRun) return true;
    return now - Date.parse(state.lastRun) >= intervalMs;
}

/**
 * Deactivate every active `archive_server` reminder, keeping its channel as the
 * guild's status channel. Reads only the scheduled.json files that exist.
 * Runs before the scheduler starts, so no tick can overwrite it.
 * @returns {number} reminders retired
 */
function retireArchiveReminders(guildIds) {
    const state = loadState();
    let retired = 0;
    for (const guildId of guildIds) {
        const file = outputPath(guildId, 'scheduled.json');
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        let changed = false;
        for (const item of data.items || []) {
            if (item.action !== RETIRED_ACTION || !item.active) continue;
            if (!state.statusChannels[guildId]) state.statusChannels[guildId] = item.channelId;
            item.active = false;
            item.retired = 'every guild is archived weekly by lib/archiveSweep.js';
            changed = true;
            retired++;
            log.info('retireArchiveReminder', { guildId, itemId: item.id, statusChannelId: item.channelId });
        }
        if (changed) {
            data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
        }
    }
    if (retired > 0) saveState(state);
    return retired;
}

/** Run `fn` after every run already queued. One guild archive at a time. */
function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
}

/**
 * Archive one guild through the shared queue.
 * @param {Guild} guild
 * @param {TextChannel|null} statusChannel - null = log only
 */
function archiveGuild(guild, statusChannel, options) {
    return enqueue(() => archiveFn(guild, statusChannel, options));
}

/** The guild's configured status channel, or null (none, or no longer reachable). */
async function statusChannelFor(guild, state) {
    const channelId = state.statusChannels[guild.id];
    if (!channelId) return null;
    try {
        return await client.channels.fetch(channelId);
    } catch (err) {
        log.warn('archiveStatus', { guildId: guild.id, channelId, reason: `status channel unreachable, logging only: ${err.message}` });
        return null;
    }
}

function describe(guild, outcome) {
    const name = JSON.stringify(guild.name || '');
    if (outcome.failed) return `${guild.id} ${name} failed: ${outcome.failed}`;
    const verdict = outcome.errors > 0 ? 'partial' : 'ok';
    return `${guild.id} ${name} ${verdict} archived=${outcome.archived} skipped=${outcome.skipped} errors=${outcome.errors}`;
}

/**
 * Archive every guild in the client's cache, one after another, then log one
 * line naming each guild and its outcome, plus any guild the previous sweep
 * archived that this one did not.
 */
async function runSweep() {
    if (sweeping) return null;
    sweeping = true;
    try {
        const state = loadState();
        const guilds = [...client.guilds.cache.values()];
        const lines = [];
        let clean = true;
        for (const guild of guilds) {
            if (stopped) return null;
            let outcome;
            try {
                outcome = await archiveGuild(guild, await statusChannelFor(guild, state));
            } catch (err) {
                log.error('archive_sweep_guild', err, { guildId: guild.id });
                outcome = { failed: err.message };
            }
            if (outcome.failed || outcome.errors > 0) clean = false;
            lines.push(describe(guild, outcome));
        }
        if (stopped) return null;

        const ids = guilds.map(g => g.id);
        const dropped = state.guilds.filter(id => !ids.includes(id));
        const summary = { guilds: ids.length, results: lines.join('; ') };
        if (dropped.length > 0) summary.dropped = dropped.join(',');
        if (clean && dropped.length === 0) log.success('archiveSweep', summary);
        else log.warn('archiveSweep', summary);

        // Re-read: a reminder retired or a status channel set during the run.
        saveState({ ...loadState(), lastRun: new Date().toISOString(), guilds: ids });
        return { lines, dropped };
    } finally {
        sweeping = false;
    }
}

async function check() {
    try {
        if (!stopped && isDue(loadState())) await runSweep();
    } catch (err) {
        log.error('archive_sweep', err);
    }
}

/**
 * Start the weekly sweep. First check a minute after start (a sweep that came
 * due while the bot was down runs then), then hourly.
 */
function startArchiveSweep(discordClient, { archive: archiveImpl, firstCheckMs = FIRST_CHECK_MS, checkMs = CHECK_MS } = {}) {
    client = discordClient;
    if (archiveImpl) archiveFn = archiveImpl;
    stopped = false;
    const first = setTimeout(check, firstCheckMs);
    const every = setInterval(check, checkMs);
    first.unref?.();
    every.unref?.();
    timers = [first, every];
}

function stopArchiveSweep() {
    stopped = true;
    timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    timers = [];
}

/** A guild the bot just joined: archive it now, not up to a week from now. */
function onGuildJoined(guild) {
    if (stopped) return Promise.resolve(null);
    return archiveGuild(guild, null)
        .then((outcome) => {
            log.success('archiveJoinedGuild', { guildId: guild.id, result: describe(guild, outcome) });
            return outcome;
        })
        .catch((err) => {
            log.error('archive_joined_guild', err, { guildId: guild.id });
            return null;
        });
}

module.exports = {
    startArchiveSweep,
    stopArchiveSweep,
    retireArchiveReminders,
    archiveGuild,
    onGuildJoined,
    runSweep,
    isDue,
    loadState,
    WEEK_MS,
};
