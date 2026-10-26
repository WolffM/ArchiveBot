/**
 * Copy the on-disk archive into dataplatform's data endpoint (namespace
 * `archivebot`), idempotently.
 *
 * Keys carry ids only; names live in the records they describe:
 *
 *   <guild>/<channel>/batches/<ms>.json                 archive_<ms>.json, immutable
 *   <guild>/<channel>/authors/<ms>.json                 authors_<ms>.json, immutable
 *   <guild>/<channel>/attachments/<message>/<attachment> one per recorded attachment
 *   <guild>/<channel>/legacy/<folder>/<file>            files no record claims (pre-2024)
 *   <guild>/<channel>/names/<folder>                    every folder name the channel had
 *   <guild>/snapshots/archive-<yyyy-mm-dd>.db           VACUUM INTO of archive.db
 *   log.csv
 *
 * archive.db itself stays a local cache: every batch file it was built from is
 * in the store, so it can be rebuilt. The snapshot is insurance, not the copy.
 *
 * Every upload sends its sha256 and the store refuses one that differs, so an
 * `uploaded` or `same` entry in the manifest is a store-verified byte match.
 * A key that exists with OTHER bytes is a `conflict`: reported, never
 * overwritten. Nothing here deletes local files.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { sha256File, DataError } = require('./dataStore');
const { planChannel } = require('./archiveRepair');
const { attachmentFileName } = require('./archive');
const { outputPath, OUTPUT_ROOT } = require('./paths');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger } = require('./ledger');

const log = createLogger('archiveImport');

const BATCH = /^archive_(\d+)\.json$/;
const AUTHORS = /^authors_(\d+)\.json$/;
const CONCURRENCY = 4;

function manifestPath() {
    return outputPath('import', 'manifest.jsonl');
}

/** key → entry, from the last run. Lets a restart skip files already verified. */
function loadManifest() {
    const map = new Map();
    const file = manifestPath();
    if (!fs.existsSync(file)) return map;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line);
        map.set(entry.key, entry);
    }
    return map;
}

function channelIdOf(folderName) {
    const m = /_(\d+)$/.exec(folderName);
    return m ? m[1] : null;
}

/** Everything one guild contributes: `{key, file, contentType}` (or `{key, body}`). */
function guildItems(guildId) {
    const guildDir = outputPath(guildId);
    const items = [];
    for (const entry of fs.readdirSync(guildDir, { withFileTypes: true })) {
        const channelId = entry.isDirectory() ? channelIdOf(entry.name) : null;
        if (!channelId) continue;
        const folder = path.join(guildDir, entry.name);
        const base = `${guildId}/${channelId}`;
        items.push({ key: `${base}/names/${entry.name}`, body: Buffer.from(entry.name), contentType: 'text/plain; charset=utf-8' });

        for (const f of fs.readdirSync(folder)) {
            let m;
            if ((m = BATCH.exec(f))) items.push({ key: `${base}/batches/${m[1]}.json`, file: path.join(folder, f), contentType: 'application/json' });
            else if ((m = AUTHORS.exec(f))) items.push({ key: `${base}/authors/${m[1]}.json`, file: path.join(folder, f), contentType: 'application/json' });
        }

        const plan = planChannel(folder);
        const dir = path.join(folder, 'attachments');
        for (const a of plan.ok) {
            items.push({ key: `${base}/attachments/${a.messageId}/${a.id}`, file: path.join(dir, attachmentFileName(a)), contentType: a.contentType });
        }
        for (const r of plan.rename) {
            items.push({ key: `${base}/attachments/${r.messageId}/${r.id}`, file: path.join(dir, r.from), contentType: r.contentType });
        }
        for (const f of plan.legacy) {
            if (f.endsWith('.part')) continue;
            items.push({ key: `${base}/legacy/${entry.name}/${f}`, file: path.join(dir, f) });
        }
    }
    return items;
}

/** A consistent copy of a live WAL database, without stopping its writer. */
async function snapshotDb(dbPath, dest) {
    fs.rmSync(dest, { force: true });
    const db = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        await db.run('VACUUM INTO ?', [dest]);
    } finally {
        await db.close();
    }
}

class ImportRun {
    constructor(ds, previous) {
        this.ds = ds;
        this.previous = previous;
        this.entries = [];
        this.counts = { uploaded: 0, same: 0, skipped: 0, conflict: 0, failed: 0, bytes: 0 };
    }

    record(entry) {
        if (!entry.transient) this.entries.push(entry);
        this.counts[entry.status]++;
        if (entry.status === 'uploaded') this.counts.bytes += entry.size;
    }

    async one(item) {
        let stat = null;
        if (item.file) {
            try {
                stat = fs.statSync(item.file);
            } catch (err) {
                this.record({ key: item.key, file: item.file, status: 'failed', error: err.message });
                return;
            }
            const prev = this.previous.get(item.key);
            if (prev && (prev.status === 'uploaded' || prev.status === 'same' || prev.status === 'skipped')
                && prev.file === item.file && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
                this.record({ ...prev, status: 'skipped' });
                return;
            }
        }
        try {
            const sha256 = item.file ? await sha256File(item.file) : require('crypto').createHash('sha256').update(item.body).digest('hex');
            const size = item.file ? stat.size : item.body.length;
            const base = { key: item.key, file: item.file || null, size, mtimeMs: stat ? stat.mtimeMs : null, sha256, transient: item.transient || undefined };
            const existing = await this.ds.head(item.key);
            if (existing) {
                this.record({ ...base, status: existing.sha256 === sha256 ? 'same' : 'conflict', storeSha256: existing.sha256 });
                return;
            }
            const opts = { createOnly: true, contentType: item.contentType || undefined, sha256 };
            const rec = item.file
                ? await this.ds.putFile(item.key, item.file, opts)
                : await this.ds.put(item.key, item.body, opts);
            this.record({ ...base, status: rec.sha256 === sha256 ? 'uploaded' : 'conflict', storeSha256: rec.sha256 });
        } catch (err) {
            // Unbound, or the store refusing every key, ends the run: it is not per-file.
            if (err instanceof DataError && (err.status === 401 || err.status === 403)) throw err;
            this.record({ key: item.key, file: item.file || null, status: 'failed', error: err.message });
        }
    }

    async all(items) {
        let next = 0;
        const worker = async () => {
            while (next < items.length) await this.one(items[next++]);
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }
}

function archivedGuilds() {
    if (!fs.existsSync(OUTPUT_ROOT)) return [];
    return fs.readdirSync(OUTPUT_ROOT)
        .filter((g) => /^\d+$/.test(g) && fs.existsSync(outputPath(g, 'archive.db')));
}

/**
 * Import every archived guild. Resolves the counts; rejects with a DataError
 * 401/403 when the key is not (yet) bound, before uploading anything.
 */
async function importAll(ds, { now = new Date() } = {}) {
    // Fails fast on an unbound key, and is the call that files the pending
    // binding request in Command Station.
    const storeLog = await ds.head('log.csv');

    const run = new ImportRun(ds, loadManifest());
    const stamp = now.toISOString().slice(0, 10);
    for (const guildId of archivedGuilds()) {
        const items = guildItems(guildId);
        const snapKey = `${guildId}/snapshots/archive-${stamp}.db`;
        if (!(await ds.head(snapKey))) {
            const tmp = outputPath('import', `${guildId}-snapshot.db`);
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            await snapshotDb(outputPath(guildId, 'archive.db'), tmp);
            items.push({ key: snapKey, file: tmp, contentType: 'application/vnd.sqlite3', transient: true });
        }
        await run.all(items);
        for (const item of items) if (item.transient) fs.rmSync(item.file, { force: true });
        log.info('importGuild', { guildId, items: items.length, ...run.counts });
    }
    // Seeded once. After that the bot appends to the store's copy, and the
    // local file is only history the store already has.
    const logCsv = outputPath('log.csv');
    if (!storeLog && fs.existsSync(logCsv)) await run.one({ key: 'log.csv', file: logCsv, contentType: 'text/csv' });

    fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
    const tmp = `${manifestPath()}.tmp`;
    fs.writeFileSync(tmp, run.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, manifestPath());
    return run.counts;
}

const FIRST_RUN_DELAY_MS = 30 * 1000;
const UNBOUND_RETRY_MS = 10 * 60 * 1000;
const SWEEP_MS = 24 * 60 * 60 * 1000;

let timer = null;
let running = false;

/**
 * One import, as the bot runs it. Returns the delay before the next one:
 * soon while the key is unbound (the operator approves it in Command Station,
 * and the import should start without a restart), daily once it works, so
 * new archive runs reach the store.
 */
async function runImport(ds) {
    if (running) return SWEEP_MS;
    running = true;
    try {
        const counts = await importAll(ds);
        log.success('import', counts);
        mirrorToLedger('archivebot.import', 'archive import ran', counts);
        if (counts.conflict || counts.failed) {
            log.warn('import', { conflict: counts.conflict, failed: counts.failed, manifest: manifestPath() });
        }
        return SWEEP_MS;
    } catch (err) {
        if (err instanceof DataError && (err.status === 401 || err.status === 403)) {
            log.warn('import', {
                status: err.status,
                reason: 'archivebot namespace not bound; approve archivebot-service-key in Command Station → Account → Data bindings',
            });
            return UNBOUND_RETRY_MS;
        }
        log.error('import', err);
        return UNBOUND_RETRY_MS;
    } finally {
        running = false;
    }
}

function startImporter(ds) {
    const schedule = (ms) => {
        timer = setTimeout(async () => schedule(await runImport(ds)), ms);
        timer.unref();
    };
    schedule(FIRST_RUN_DELAY_MS);
}

function stopImporter() {
    if (timer) clearTimeout(timer);
    timer = null;
}

module.exports = { importAll, runImport, startImporter, stopImporter, guildItems, loadManifest, manifestPath, channelIdOf, snapshotDb };
