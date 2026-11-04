/**
 * scripts/check-parity.js against dataplatform's REAL listener: it reports
 * what the first central-mode takeover would do to a disk, and it never
 * writes, to the store or to the disk.
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataStore } = require('../lib/dataStore');
const { startDataListener, KEY } = require('./support/dataListener');

const G = '1200000000000000201';
const CH = '1100000000000000201';
let listener;
let root;
let ds;

beforeEach(async () => {
    listener = await startDataListener();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivebot-parity-'));
    ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
}, 20000);
afterEach(() => {
    ds.close();
    listener.stop();
    fs.rmSync(root, { recursive: true, force: true });
});

function write(rel, body) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

function check() {
    return new Promise((resolve) => {
        execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-parity.js')], {
            env: { PATH: process.env.PATH, ARCHIVEBOT_OUTPUT_DIR: root, HADOKU_DATA_URL: listener.url, HADOKU_SERVICE_KEY: KEY },
        }, (err, stdout) => resolve({ code: err ? err.code : 0, doc: JSON.parse(stdout) }));
    });
}

function treeDigest() {
    const h = crypto.createHash('sha256');
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, e.name);
            h.update(full);
            if (e.isDirectory()) walk(full);
            else h.update(fs.readFileSync(full));
        }
    };
    walk(root);
    return h.digest('hex');
}

async function seedSame() {
    write(`${G}/scheduled.json`, '{"items":[]}');
    write(`${G}/general_${CH}/archive_1700000000000.json`, '[]');
    write(`${G}/general_${CH}/authors_1700000000000.json`, '{}');
    write(`${G}/archive.db`, 'local cache');
    write('import/manifest.jsonl', '');
    await ds.put(`state/${G}/scheduled.json`, '{"items":[]}', { createOnly: true });
    await ds.put(`${G}/${CH}/names/general_${CH}`, `general_${CH}`, { createOnly: true });
    await ds.put(`${G}/${CH}/batches/1700000000000.json`, '[]', { createOnly: true });
    await ds.put(`${G}/${CH}/authors/1700000000000.json`, '{}', { createOnly: true });
}

test('a disk the store matches passes; local-only caches are not counted against it', async () => {
    await seedSame();
    const { code, doc } = await check();
    expect(code).toBe(0);
    expect(doc).toMatchObject({
        ok: true,
        state: { same: 1, differ: 0, localOnly: 0, storeOnly: 0 },
        archive: { same: 2, differ: 0, missing: 0 },
        unmapped: 0,
        local: 2,
        takeover: { refuses: false, orphans: 0, resurrects: 0 },
    });
});

test('names every state file a takeover would orphan or resurrect, and every archive file only this disk holds', async () => {
    await seedSame();
    write(`${G}/scheduled.json`, '{"items":["newer than the store"]}');
    write('Resources/late.json', '{}');
    await ds.put('state/Resources/removed-locally.json', '{}', { createOnly: true });
    write(`${G}/general_${CH}/archive_1800000000000.json`, '[]');
    write('stray.bin', 'x');
    const { cursor } = await ds.changes(0);
    const before = treeDigest();

    const { code, doc } = await check();
    expect(code).toBe(1);
    expect(doc.ok).toBe(false);
    expect(doc.paths.state).toEqual({
        differ: [`state/${G}/scheduled.json`],
        localOnly: ['state/Resources/late.json', 'state/stray.bin'],
        storeOnly: ['state/Resources/removed-locally.json'],
    });
    expect(doc.paths.archive).toEqual({ missing: [`${G}/${CH}/batches/1800000000000.json`] });
    expect(doc.takeover).toEqual({ refuses: false, orphans: 3, resurrects: 1 });

    // Read-only: the store's change feed did not move, and the disk is byte-for-byte as it was.
    expect((await ds.changes(cursor)).changes).toEqual([]);
    expect(treeDigest()).toBe(before);
});

test('an empty store beside a state tree is the refusal case', async () => {
    write(`${G}/scheduled.json`, '{"items":[]}');
    const { code, doc } = await check();
    expect(code).toBe(1);
    expect(doc.takeover).toMatchObject({ refuses: true, orphans: 1 });
});
