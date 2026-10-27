/**
 * Keep the bot's working state in dataplatform's data endpoint, beside the
 * archive (namespace `archivebot`), under `state/<path below the output root>`.
 *
 * State is everything under the output root that is not the archive: the
 * scheduler's scheduled.json, sentMessages.json, spaces.json, cardtable.json,
 * the tasklist, and whatever a later feature adds. The archive (channel
 * folders, archive.db, log.csv) and the importer's own import/ are excluded:
 * lib/archiveImport.js owns those.
 *
 * The local file stays the working copy. Reminders must fire with the endpoint
 * down, so a running bot never reads state from the store; it only keeps the
 * store's copy current. The store's copy is read once, at the start of a host
 * that has none (lib/storeRestore.js). Each changed file is a compare-and-swap PUT against the
 * version this process last wrote, so a write the bot did not make is a
 * logged `conflict` rather than a silent overwrite. The cycle after that, the
 * bot's copy wins: it is the working copy.
 */
const fs = require('fs');
const path = require('path');
const { sha256File, DataError } = require('./dataStore');
const { OUTPUT_ROOT } = require('./paths');
const { createLogger } = require('../utils/logger');

const log = createLogger('stateSync');

const SYNC_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

const NOT_STATE = new Set(['import', 'log.csv']);

/** `{key, file}` for every state file under the output root. */
function stateItems(root = OUTPUT_ROOT) {
    const items = [];
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (!rel && NOT_STATE.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // A guild's channel folders are the archive.
                if (/^\d+$/.test(rel) && /_\d+$/.test(entry.name)) continue;
                walk(full, relPath);
            } else if (entry.isFile()) {
                if (/^\d+$/.test(rel) && entry.name === 'archive.db') continue;
                if (/^\d+$/.test(rel) && /^archive\.db-(wal|shm|journal)$/.test(entry.name)) continue;
                if (entry.name.endsWith('.tmp')) continue;
                items.push({ key: `state/${relPath}`, file: full });
            }
        }
    };
    walk(root, '');
    return items;
}

/**
 * `{sha256, version}` the store last confirmed per key: an unchanged file costs
 * no request, and a changed one is swapped against the version this process
 * wrote, so a write it did not make surfaces as a 412.
 */
const confirmed = new Map();

async function syncOne(ds, item, counts) {
    const sha256 = await sha256File(item.file);
    const mine = confirmed.get(item.key);
    if (mine && mine.sha256 === sha256) {
        counts.unchanged++;
        return;
    }
    // Writers rewrite these files in place: a read mid-write is not state.
    if (item.file.endsWith('.json')) {
        try {
            JSON.parse(fs.readFileSync(item.file, 'utf8'));
        } catch (err) {
            counts.unreadable++;
            log.warn('syncState', { key: item.key, reason: 'not valid JSON (mid-write?)', error: err.message });
            return;
        }
    }
    let existing = mine;
    if (!existing) {
        // First sight since start: the store's copy is the one to swap against.
        existing = await ds.head(item.key);
        if (existing && existing.sha256 === sha256) {
            confirmed.set(item.key, { sha256, version: existing.version });
            counts.unchanged++;
            return;
        }
    }
    const opts = existing ? { ifMatch: existing.version, sha256 } : { createOnly: true, sha256 };
    if (item.file.endsWith('.json')) opts.contentType = 'application/json';
    try {
        const rec = await ds.putFile(item.key, item.file, opts);
        // The file can change while it uploads; then the next cycle sends it again.
        if (rec.sha256 === sha256) confirmed.set(item.key, { sha256, version: rec.version });
        else confirmed.delete(item.key);
        counts[existing ? 'updated' : 'created']++;
    } catch (err) {
        if (err instanceof DataError && err.status === 412) {
            confirmed.delete(item.key);
            counts.conflict++;
            log.warn('syncState', { key: item.key, reason: 'store copy written by someone else; the bot copy replaces it next cycle' });
            return;
        }
        if (err instanceof DataError && err.status === 422) {
            counts.unreadable++;
            log.warn('syncState', { key: item.key, reason: 'changed while uploading; retried next cycle' });
            return;
        }
        throw err;
    }
}

async function syncState(ds, { root } = {}) {
    const counts = { created: 0, updated: 0, unchanged: 0, unreadable: 0, conflict: 0, failed: 0 };
    for (const item of stateItems(root)) {
        try {
            await syncOne(ds, item, counts);
        } catch (err) {
            if (err instanceof DataError && (err.status === 401 || err.status === 403)) throw err;
            counts.failed++;
            log.error('sync_state', err, { key: item.key });
        }
    }
    return counts;
}

let timer = null;

async function runSync(ds) {
    try {
        const counts = await syncState(ds);
        if (counts.created || counts.updated || counts.unreadable || counts.conflict || counts.failed) {
            log.success('syncState', counts);
        }
    } catch (err) {
        if (err instanceof DataError && (err.status === 401 || err.status === 403)) {
            log.warn('syncState', { status: err.status, reason: 'archivebot namespace not bound' });
        } else {
            log.error('sync_state', err);
        }
    }
}

function startStateSync(ds) {
    const schedule = (ms) => {
        timer = setTimeout(async () => {
            await runSync(ds);
            schedule(SYNC_MS);
        }, ms);
        timer.unref();
    };
    schedule(FIRST_RUN_DELAY_MS);
}

function stopStateSync() {
    if (timer) clearTimeout(timer);
    timer = null;
}

function resetConfirmed() {
    confirmed.clear();
}

module.exports = { stateItems, syncState, startStateSync, stopStateSync, resetConfirmed };
