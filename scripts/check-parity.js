#!/usr/bin/env node
/**
 * Local tree vs the data endpoint, READ-ONLY: every file under the output root
 * is hashed and compared with the store's listing. Nothing is written, locally
 * or to the store (the only store call is `list`), so it is safe beside the
 * running bot and needs no lease.
 *
 *   ARCHIVEBOT_OUTPUT_DIR=<root> HADOKU_DATA_URL=<url> HADOKU_SERVICE_KEY=<key> \
 *     node scripts/check-parity.js
 *
 * It answers the question a central-mode cutover depends on: what would the
 * first takeover reconcile (lib/reconcile.js) do to THIS disk?
 *
 * - **state** (`state/<rel>`, lib/stateSync.js's scope): the store wins at
 *   takeover. A local file whose bytes differ, or that the store lacks, moves
 *   to `.central/orphans/`; a store-only key is downloaded into the live tree
 *   (on-node mode never tombstones, so that is a file the bot removed coming
 *   back). Any of the three fails the check.
 * - **archive** (batches, authors, names, attachments, kept mismatches,
 *   legacy: lib/archiveImport.js `guildItems`): a union at takeover, never
 *   orphaned. `missing` is the importer's lag: a file only this disk holds,
 *   which a takeover on ANOTHER node would not have. `differ` is a conflict
 *   the importer refused to overwrite.
 * - **unmapped**: a local file no store key covers and no rule keeps local.
 * - **local**: kept local by design (`<guild>/archive.db*`, `import/`,
 *   `.central/`, `*.tmp`, `*.part`, `log.csv` once seeded).
 *
 * Exit 0 only when state and archive are all `same` and nothing is unmapped.
 * Stdout is one JSON document either way.
 */
const fs = require('fs');
const path = require('path');
const { DataStore, sha256File } = require('../lib/dataStore');
const { OUTPUT_ROOT } = require('../lib/paths');
const { stateItems } = require('../lib/stateSync');
const { guildItems } = require('../lib/archiveImport');

const STATE_PREFIX = 'state/';
const LOCAL_ONLY = [
    /^\d+\/archive\.db(-(wal|shm|journal))?$/,
    /^import\//,
    /^\.central\//,
    /\.tmp$/,
    /\.part$/,
];
const LIST_CAP = 50;

function walk(root) {
    const out = [];
    const rec = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) rec(path.join(dir, e.name), r);
            else if (e.isFile()) out.push(r);
        }
    };
    rec(root, '');
    return out;
}

/** `rel` → `{key, kind}` for every local file a store key covers. */
function expectedKeys(root) {
    const map = new Map();
    for (const it of stateItems(root)) map.set(path.relative(root, it.file), { key: it.key, kind: 'state' });
    for (const g of fs.readdirSync(root)) {
        if (!/^\d+$/.test(g) || !fs.statSync(path.join(root, g)).isDirectory()) continue;
        for (const it of guildItems(g)) {
            if (it.file) map.set(path.relative(root, it.file), { key: it.key, kind: 'archive' });
        }
    }
    return map;
}

async function main() {
    if (OUTPUT_ROOT !== process.env.ARCHIVEBOT_OUTPUT_DIR) throw new Error('set ARCHIVEBOT_OUTPUT_DIR to the tree to check');
    if (!fs.existsSync(OUTPUT_ROOT)) throw new Error(`${OUTPUT_ROOT} does not exist`);
    const ds = new DataStore({ url: process.env.HADOKU_DATA_URL, key: process.env.HADOKU_SERVICE_KEY, ns: 'archivebot' });
    const store = new Map();
    try {
        for await (const it of ds.list('')) store.set(it.path, it);
    } finally {
        ds.close();
    }

    const expected = expectedKeys(OUTPUT_ROOT);
    const r = {
        root: OUTPUT_ROOT,
        storeKeys: store.size,
        state: { same: 0, differ: [], localOnly: [], storeOnly: [] },
        archive: { same: 0, differ: [], missing: [] },
        unmapped: [],
        local: 0,
    };
    for (const rel of walk(OUTPUT_ROOT)) {
        const exp = expected.get(rel);
        if (!exp) {
            if (rel === 'log.csv' && store.has('log.csv')) r.local++;
            else if (rel === 'log.csv' || !LOCAL_ONLY.some((re) => re.test(rel))) r.unmapped.push(rel);
            else r.local++;
            continue;
        }
        const it = store.get(exp.key);
        const side = r[exp.kind];
        if (!it) {
            (exp.kind === 'state' ? side.localOnly : side.missing).push(exp.key);
            continue;
        }
        if (it.sha256 && it.sha256 === await sha256File(path.join(OUTPUT_ROOT, rel))) side.same++;
        else side.differ.push(exp.key);
    }
    const localState = new Set([...expected.values()].filter((e) => e.kind === 'state').map((e) => e.key));
    for (const key of store.keys()) {
        if (key.startsWith(STATE_PREFIX) && !localState.has(key)) r.state.storeOnly.push(key);
    }

    const ok = r.state.differ.length + r.state.localOnly.length + r.state.storeOnly.length
        + r.archive.differ.length + r.archive.missing.length + r.unmapped.length === 0
        && r.state.same > 0;
    const counts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
    const cap = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, v.slice(0, LIST_CAP)]));
    const doc = {
        ok,
        root: r.root,
        storeKeys: r.storeKeys,
        state: counts(r.state),
        archive: counts(r.archive),
        unmapped: r.unmapped.length,
        local: r.local,
        // What the first central-mode takeover on this disk would do to state.
        takeover: {
            refuses: [...store.keys()].every((k) => !k.startsWith(STATE_PREFIX)) && localState.size > 0,
            orphans: r.state.differ.length + r.state.localOnly.length,
            resurrects: r.state.storeOnly.length,
        },
        paths: { state: cap(r.state), archive: cap(r.archive), unmapped: r.unmapped.slice(0, LIST_CAP) },
    };
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return ok ? 0 : 1;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (err) => {
        process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
        process.exitCode = 2;
    });
}

module.exports = { expectedKeys, main };
