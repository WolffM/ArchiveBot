/**
 * Takeover: make this node's output root a working copy of the store before
 * the bot serves (hadoku-fleet-manager docs/service-state.md, item 6).
 *
 * **State** (`state/<path>`, lib/stateSync.js's scope): the store wins.
 * - A file the store has and the disk lacks, or holds with other bytes, is
 *   downloaded. Other local bytes move to `.central/orphans/<stamp>/` first.
 * - A local file the store lacks moves to `.central/orphans/<stamp>/`. Never
 *   deleted: it is whatever this node wrote that never reached the store.
 * - An EMPTY store beside a non-empty local state tree refuses: that is a node
 *   pointed at the store before its import ran, and reconciling would orphan
 *   every reminder.
 * - The store's versions seed the state sync, so its first writes swap
 *   against what is really there.
 * The state is a few small JSON files, so the store's listing (hashes, no
 * bodies) is read whole every takeover rather than trusted from a cursor.
 *
 * **Archive** (`<guild>/<channel>/batches|authors/<ms>.json`): records are
 * immutable, so the two sides are a union, never a choice. Records the store
 * gained since this node last looked are fetched into the channel's folder and
 * ingested into that guild's archive.db. Records only the disk has are the
 * importer's (lib/archiveImport.js, create-only). "Since this node last looked"
 * is the change feed: the cursor persists in `.central/cursor.json`, so a warm
 * takeover reads only what moved. A node with no cursor reads the feed from 0.
 * Attachments are not fetched: the store holds them and the local copy is a
 * cache the bot never reads back.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sha256File } = require('./dataStore');
const { OUTPUT_ROOT } = require('./paths');
const { stateItems, seedConfirmed } = require('./stateSync');
const { createLogger } = require('../utils/logger');

const log = createLogger('reconcile');

const STATE_PREFIX = 'state/';
const CENTRAL_DIR = '.central';
const RECORD = /^(\d+)\/(\d+)\/(batches|authors)\/(\d+)\.json$/;
const NAME = /^(\d+)\/(\d+)\/names\/(.+)$/;

class CentralRefusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'CentralRefusal';
    }
}

/** `<root>/<rel>`, refusing a key that would land outside the root. */
function under(root, rel) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`refusing to write ${rel} outside ${root}`);
    return target;
}

function writeAtomic(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
}

function stampNow(now) {
    return now.toISOString().replace(/[:.]/g, '-');
}

/** Move `<root>/<rel>` under `.central/orphans/<stamp>/`. */
function orphan(root, rel, stamp) {
    const dest = path.join(root, CENTRAL_DIR, 'orphans', stamp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(root, rel), dest);
}

/** Store wins for `state/`. Resolves `{same, downloaded, orphaned}`; throws CentralRefusal. */
async function reconcileState(ds, { root = OUTPUT_ROOT, now = new Date() } = {}) {
    const remote = new Map();
    for await (const it of ds.list(STATE_PREFIX)) remote.set(it.path.slice(STATE_PREFIX.length), it);
    const local = stateItems(root).map((i) => i.key.slice(STATE_PREFIX.length));
    if (remote.size === 0 && local.length > 0) {
        throw new CentralRefusal(
            `the store holds nothing under ${STATE_PREFIX} but ${root} holds ${local.length} state file(s): ` +
            'a node pointed at the store before its import ran. Let the on-node bot sync it first.',
        );
    }
    const stamp = stampNow(now);
    const counts = { same: 0, downloaded: 0, orphaned: 0 };
    for (const [rel, it] of remote) {
        const file = under(root, rel);
        if (fs.existsSync(file)) {
            const sha = await sha256File(file);
            if (it.sha256 && sha === it.sha256) {
                seedConfirmed(it.path, sha, it.version);
                counts.same++;
                continue;
            }
        }
        const rec = await ds.get(it.path);
        if (!rec) continue; // removed between the listing and the read
        if (fs.existsSync(file)) {
            orphan(root, rel, stamp);
            counts.orphaned++;
        }
        writeAtomic(file, rec.body);
        seedConfirmed(it.path, rec.sha256 || crypto.createHash('sha256').update(rec.body).digest('hex'), rec.version);
        counts.downloaded++;
    }
    for (const rel of local) {
        if (remote.has(rel)) continue;
        orphan(root, rel, stamp);
        counts.orphaned++;
    }
    if (counts.downloaded || counts.orphaned) {
        log.warn('reconcileState', { ...counts, orphans: path.join(root, CENTRAL_DIR, 'orphans', stamp) });
    }
    return counts;
}

function cursorFile(root) {
    return path.join(root, CENTRAL_DIR, 'cursor.json');
}

function readCursor(root) {
    const file = cursorFile(root);
    if (!fs.existsSync(file)) return 0;
    const { cursor } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(cursor) ? cursor : 0;
}

/**
 * Every folder a channel has on disk: a renamed channel keeps one per name it
 * had, and each holds the batches archived under that name.
 */
function channelFolders(root, guildId, channelId) {
    const guildDir = path.join(root, guildId);
    if (!fs.existsSync(guildDir)) return [];
    return fs.readdirSync(guildDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.endsWith(`_${channelId}`))
        .map((e) => e.name)
        .sort();
}

/**
 * Fetch archive records the store gained since the cursor; ingest them.
 * `ingest(guildId)` builds or updates that guild's archive.db from its files.
 * Resolves `{fetched, guilds, cursor}`.
 */
async function reconcileArchive(ds, { root = OUTPUT_ROOT, ingest } = {}) {
    const since = readCursor(root);
    const { changes, cursor } = await ds.changes(since);
    const latest = new Map();
    for (const c of changes) latest.set(c.path, c);

    const names = new Map();
    for (const c of latest.values()) {
        const m = NAME.exec(c.path);
        if (!m || c.deleted) continue;
        const channel = `${m[1]}/${m[2]}`;
        const prev = names.get(channel);
        if (!prev || c.version > prev.version) names.set(channel, { folder: m[3], version: c.version });
    }

    const touched = new Set();
    let fetched = 0;
    for (const c of latest.values()) {
        const m = RECORD.exec(c.path);
        if (!m || c.deleted) continue;
        const [, guildId, channelId, kind, ms] = m;
        const base = `${kind === 'batches' ? 'archive' : 'authors'}_${ms}.json`;
        const onDisk = channelFolders(root, guildId, channelId);
        // Held under ANY of the channel's folders is held: a record is keyed by
        // channel id, not by the name it was archived under.
        if (onDisk.some((f) => fs.existsSync(path.join(root, guildId, f, base)))) continue;
        // A new record goes in the store's current name when that folder exists, else the first on disk.
        const named = names.get(`${guildId}/${channelId}`)?.folder;
        const folder = (named && onDisk.includes(named) ? named : onDisk[0]) || named;
        if (!folder) throw new Error(`${guildId}/${channelId} has ${kind} in the store but no folder name`);
        const file = under(root, path.join(guildId, folder, base));
        const rec = await ds.get(c.path);
        if (!rec) continue;
        writeAtomic(file, rec.body);
        fetched++;
        touched.add(guildId);
    }
    for (const guildId of touched) await ingest(guildId);
    writeAtomic(cursorFile(root), JSON.stringify({ cursor }));
    if (fetched) log.info('reconcileArchive', { since, cursor, fetched, guilds: touched.size });
    return { fetched, guilds: touched.size, cursor };
}

module.exports = { reconcileState, reconcileArchive, CentralRefusal, STATE_PREFIX, CENTRAL_DIR };
