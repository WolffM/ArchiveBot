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
 * The local file is the working copy. Reminders must fire with the endpoint
 * down, so a running bot never reads state from the store; it only keeps the
 * store's copy current. Each changed file is a compare-and-swap PUT against the
 * version this process last wrote, so a write the bot did not make is a
 * logged `conflict` rather than a silent overwrite. The cycle after that, the
 * bot's copy wins.
 *
 * Two modes (lib/central.js):
 *
 * - **on-node** (`ARCHIVEBOT_STATE_STORE` unset): every 10 min, the store is a
 *   copy, and nothing is ever deleted from it. The store's copy is read once,
 *   at the start of a host that has none (lib/storeRestore.js).
 * - **central**: the store is the truth and the disk a working copy reconciled
 *   from it on takeover (lib/reconcile.js, which seeds `confirmed`). The pass
 *   runs every 15 s (the loss bound), every write carries the lease token (the
 *   store's fence), and a file the bot removed becomes a tombstone, or the next
 *   takeover would bring it back.
 */
const fs = require('fs');
const path = require('path');
const { sha256File, DataError, LeaseNotHeld, isLeaseLost } = require('./dataStore');
const { OUTPUT_ROOT } = require('./paths');
const { createLogger } = require('../utils/logger');

const log = createLogger('stateSync');

const SYNC_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

const CENTRAL_SYNC_MS = 15 * 1000;

// `.central/` is lib/reconcile.js's own: orphans and the change-feed cursor.
const NOT_STATE = new Set(['import', 'log.csv', '.central']);

/**
 * A file whose mtime is this close to when it was confirmed is hashed again
 * rather than trusted by its stat: mtimes come from a coarse clock, so a write
 * in the same tick as the look can leave mtime and size unchanged.
 */
const RACY_MS = 2000;

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
 * `{sha256, version, mtimeMs?, size?, at?}` the store last confirmed per key:
 * an unchanged file costs no request (and, by its stat, no hash), and a changed
 * one is swapped against the version this process wrote, so a write it did not
 * make surfaces as a 412.
 */
const confirmed = new Map();

function confirm(key, sha256, version, st) {
    confirmed.set(key, { sha256, version, ...(st ? { mtimeMs: st.mtimeMs, size: st.size, at: Date.now() } : {}) });
}

function unchangedByStat(mine, st) {
    return Boolean(mine && mine.at && mine.mtimeMs === st.mtimeMs && mine.size === st.size && st.mtimeMs < mine.at - RACY_MS);
}

/** A lease refusal ends the pass: nothing after it would be accepted either. */
function endsPass(err) {
    return err instanceof LeaseNotHeld || isLeaseLost(err)
        || (err instanceof DataError && (err.status === 401 || err.status === 403));
}

async function syncOne(ds, item, counts) {
    const st = fs.statSync(item.file);
    const mine = confirmed.get(item.key);
    if (unchangedByStat(mine, st)) {
        counts.unchanged++;
        return;
    }
    const sha256 = await sha256File(item.file);
    if (mine && mine.sha256 === sha256) {
        confirm(item.key, sha256, mine.version, st);
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
            confirm(item.key, sha256, existing.version, st);
            counts.unchanged++;
            return;
        }
    }
    const opts = existing ? { ifMatch: existing.version, sha256 } : { createOnly: true, sha256 };
    if (item.file.endsWith('.json')) opts.contentType = 'application/json';
    try {
        const rec = await ds.putFile(item.key, item.file, opts);
        // The file can change while it uploads; then the next cycle sends it again.
        if (rec.sha256 === sha256) confirm(item.key, sha256, rec.version, st);
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

/** A file the bot removed: tombstoned, compare-and-swap on the version it last confirmed. */
async function deleteOne(ds, key, mine, counts) {
    try {
        await ds.delete(key, { ifMatch: mine.version });
        counts.deleted++;
    } catch (err) {
        if (!(err instanceof DataError && err.status === 412)) throw err;
        counts.conflict++;
        log.warn('syncState', { key, reason: 'removed locally, but the store copy was written by someone else; left in place' });
    }
    confirmed.delete(key);
}

/**
 * One pass. `deletes` (central mode): a key this process confirmed whose file
 * is gone is tombstoned. Resolves the counts; rejects when the pass cannot go
 * on (unbound key, or the lease not ours).
 */
async function syncState(ds, { root, deletes = false } = {}) {
    const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, unreadable: 0, conflict: 0, failed: 0 };
    const items = stateItems(root);
    for (const item of items) {
        try {
            await syncOne(ds, item, counts);
        } catch (err) {
            if (endsPass(err)) throw err;
            counts.failed++;
            log.error('sync_state', err, { key: item.key });
        }
    }
    if (deletes) {
        const present = new Set(items.map((i) => i.key));
        for (const [key, mine] of [...confirmed]) {
            if (present.has(key)) continue;
            try {
                await deleteOne(ds, key, mine, counts);
            } catch (err) {
                if (endsPass(err)) throw err;
                counts.failed++;
                log.error('sync_state', err, { key });
            }
        }
    }
    return counts;
}

let timer = null;
let inFlight = null;

/** One logged pass. Resolves true when every file is in the store as it is on disk. */
async function runSync(ds, opts = {}) {
    try {
        const counts = await syncState(ds, opts);
        if (counts.created || counts.updated || counts.deleted || counts.unreadable || counts.conflict || counts.failed) {
            log.success('syncState', counts);
        }
        return !(counts.unreadable || counts.conflict || counts.failed);
    } catch (err) {
        if (err instanceof DataError && (err.status === 401 || err.status === 403)) {
            log.warn('syncState', { status: err.status, reason: 'archivebot namespace not bound' });
        } else if (err instanceof LeaseNotHeld || isLeaseLost(err)) {
            log.warn('syncState', { reason: 'lease not held; nothing written', error: err.message });
        } else {
            log.error('sync_state', err);
        }
        return false;
    }
}

/**
 * Keep syncing. `central`: every 15 s with tombstones; otherwise every 10 min.
 * `onCommitted` runs after each pass that left nothing behind (the health
 * body's `committed_s_ago`).
 */
function startStateSync(ds, { central = false, onCommitted } = {}) {
    const every = central ? CENTRAL_SYNC_MS : SYNC_MS;
    const schedule = (ms) => {
        timer = setTimeout(async () => {
            inFlight = runSync(ds, { deletes: central });
            const clean = await inFlight;
            inFlight = null;
            if (clean && onCommitted) onCommitted();
            if (timer) schedule(every);
        }, ms);
        timer.unref();
    };
    schedule(central ? every : FIRST_RUN_DELAY_MS);
}

/** Stop the timer; resolves once a pass already running has finished. */
async function stopStateSync() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (inFlight) await inFlight;
}

/** What reconcile found the store holding: the versions the next swaps go against. */
function seedConfirmed(key, sha256, version) {
    confirm(key, sha256, version, null);
}

function resetConfirmed() {
    confirmed.clear();
}

module.exports = { stateItems, syncState, runSync, startStateSync, stopStateSync, seedConfirmed, resetConfirmed };
