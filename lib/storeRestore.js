/**
 * Rebuild a host's output root from dataplatform's data endpoint, so the bot
 * can start on a host that holds nothing.
 *
 * Three things, each only when it is missing locally:
 *
 * - **State** (`state/<path>` → `<root>/<path>`), when the root holds no state
 *   file at all. Not per file: lib/stateSync.js never deletes from the store,
 *   so filling single gaps would resurrect a file the bot itself removed.
 * - **A guild's archive** (`<g>/<ch>/batches|authors/<ms>.json` →
 *   `<g>/<folder>/archive_|authors_<ms>.json`), when its `archive.db` is
 *   missing; the db is then rebuilt from those files, as `/archiveserver`
 *   would. Without it every channel would be fetched again from the
 *   beginning. `<folder>` is the channel's last-written `names/` record. A
 *   renamed channel had several folders and they become one; the index keys
 *   on the channel id, and the next archive run uses the current name anyway.
 * - **The import manifest**, from the store's listing: it is how the repair
 *   knows a pruned attachment is held (lib/archiveRepair.js `storedKeys`), and
 *   without it the repair would download every attachment again.
 *
 * Attachments are not restored: the store holds them, and the local copy is a
 * cache the bot never reads back.
 *
 * The store is only asked when something is missing, so a host that has its
 * files starts with the endpoint down. One that is missing something and
 * cannot get it refuses to start (the caller exits; PM2 retries): starting
 * empty would drop every reminder, the state sync would then replace the
 * store's copy with the empty one, and the archive would be fetched again
 * from the beginning.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { OUTPUT_ROOT, outputPath } = require('./paths');
const { stateItems } = require('./stateSync');
const { manifestPath } = require('./archiveImport');
const { initializeDatabaseIfNeeded, ingestOrphanedFiles } = require('./archive');
const { createLogger } = require('../utils/logger');

const log = createLogger('storeRestore');

const STATE = /^state\/(.+)$/;
const RECORD = /^(\d+)\/(\d+)\/(batches|authors)\/(\d+)\.json$/;
const NAME = /^(\d+)\/(\d+)\/names\/(.+)$/;
const CONCURRENCY = 4;

/** `<root>/<rel>`, refusing a key that would land outside the root. */
function under(rel) {
    const target = path.resolve(OUTPUT_ROOT, rel);
    if (!target.startsWith(path.resolve(OUTPUT_ROOT) + path.sep)) throw new Error(`refusing to restore ${rel} outside ${OUTPUT_ROOT}`);
    return target;
}

function writeAtomic(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
}

async function fetchTo(ds, key, file) {
    const rec = await ds.get(key);
    if (!rec) throw new Error(`${key} listed but absent`);
    writeAtomic(file, rec.body);
}

async function fetchAll(ds, jobs) {
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const { key, file } = jobs[next++];
            await fetchTo(ds, key, file);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** The archive's files per guild, `{folder per channel, jobs}`, from the listing. */
function archivePlan(items) {
    const names = new Map();
    for (const it of items) {
        const m = NAME.exec(it.path);
        if (!m) continue;
        const channel = `${m[1]}/${m[2]}`;
        const prev = names.get(channel);
        if (!prev || it.version > prev.version) names.set(channel, { folder: m[3], version: it.version });
    }
    const guilds = new Map();
    for (const it of items) {
        const m = RECORD.exec(it.path);
        if (!m) continue;
        const [, guildId, channelId, kind, ms] = m;
        const named = names.get(`${guildId}/${channelId}`);
        if (!named) throw new Error(`${guildId}/${channelId} has batches but no names/ record`);
        const file = under(path.join(guildId, named.folder, `${kind === 'batches' ? 'archive' : 'authors'}_${ms}.json`));
        if (!guilds.has(guildId)) guilds.set(guildId, []);
        guilds.get(guildId).push({ key: it.path, file });
    }
    return guilds;
}

/** Manifest entries for every listed record: the store's own word that it holds them. */
function manifestFromListing(items) {
    return items
        .filter((it) => !STATE.test(it.path))
        .map((it) => ({ key: it.path, file: null, size: it.size, mtimeMs: null, sha256: it.sha256, status: 'same', storeSha256: it.sha256 }));
}

/**
 * Guild folders holding channel folders but no archive.db. A guild with only
 * state (cardtable.json, spaces.json) was never archived and needs nothing.
 */
function archivesWithoutDb() {
    if (!fs.existsSync(OUTPUT_ROOT)) return [];
    return fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && !fs.existsSync(outputPath(e.name, 'archive.db')))
        .filter((e) => fs.readdirSync(outputPath(e.name), { withFileTypes: true }).some((c) => c.isDirectory() && /_\d+$/.test(c.name)))
        .map((e) => e.name);
}

/**
 * What is missing locally, without asking the store. A host with no state is
 * a fresh one, and its archive is missing too, though no folder says so yet.
 */
function restoreNeeded() {
    const needs = [];
    if (stateItems().length === 0) needs.push('state', 'archive');
    else if (archivesWithoutDb().length > 0) needs.push('archive');
    if (!fs.existsSync(manifestPath())) needs.push('manifest');
    return needs;
}

/**
 * Rebuild one guild's archive.db from its restored batches. A rebuild that
 * inserts nothing from files that hold messages is removed again, so the next
 * start retries rather than archiving onto an empty index.
 */
async function rebuildDb(guildId, batches) {
    await initializeDatabaseIfNeeded(guildId);
    await ingestOrphanedFiles(guildId);
    const dbPath = outputPath(guildId, 'archive.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    const { n } = await db.get('SELECT COUNT(*) AS n FROM raw_archive');
    await db.close();
    if (n === 0 && batches > 0) {
        for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
        throw new Error(`guild ${guildId}: ${batches} batch files restored but archive.db rebuilt empty`);
    }
    return n;
}

async function restoreFromStore(ds) {
    const counts = { state: 0, guilds: 0, files: 0, messages: 0, manifest: 0 };
    const needs = restoreNeeded();
    if (needs.length === 0) return counts;

    const items = [];
    for await (const it of ds.list('')) items.push(it);

    for (const [guildId, jobs] of needs.includes('archive') ? archivePlan(items) : []) {
        if (fs.existsSync(outputPath(guildId, 'archive.db'))) continue;
        const missing = jobs.filter((j) => !fs.existsSync(j.file));
        await fetchAll(ds, missing);
        const messages = await rebuildDb(guildId, jobs.filter((j) => path.basename(j.file).startsWith('archive_')).length);
        counts.guilds++;
        counts.files += missing.length;
        counts.messages += messages;
        log.info('restoreGuild', { guildId, files: missing.length, messages });
    }

    if (needs.includes('manifest')) {
        const entries = manifestFromListing(items);
        writeAtomic(manifestPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        counts.manifest = entries.length;
    }

    // Last, and all fetched before any is written: state on disk is what marks
    // a host as not fresh, so a restore cut short must leave none.
    if (needs.includes('state')) {
        const bodies = [];
        for (const it of items.filter((i) => STATE.test(i.path))) {
            const rec = await ds.get(it.path);
            if (!rec) throw new Error(`${it.path} listed but absent`);
            bodies.push({ file: under(STATE.exec(it.path)[1]), body: rec.body });
        }
        for (const { file, body } of bodies) writeAtomic(file, body);
        counts.state = bodies.length;
    }
    return counts;
}

module.exports = { restoreFromStore, restoreNeeded };
