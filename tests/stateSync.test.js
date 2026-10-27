/**
 * State sync against dataplatform's real listener on a scratch store, from a
 * real output tree under its own root.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataStore } = require('../lib/dataStore');
const { stateItems, syncState, resetConfirmed } = require('../lib/stateSync');
const { startDataListener, KEY, OTHER_KEY } = require('./support/dataListener');

let listener;
beforeAll(async () => { listener = await startDataListener(); }, 20000);
afterAll(() => listener?.stop());

let ds;
let root;
let seq = 0;
beforeEach(() => {
    // Each test writes its own keys: the scratch store lives for the whole file.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivebot-state-'));
    ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
    resetConfirmed();
    seq++;
});
afterEach(() => {
    ds.close();
    fs.rmSync(root, { recursive: true, force: true });
});

function write(rel, body) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

function seed() {
    const g = `13000000000000000${seq}`;
    write(`${g}/scheduled.json`, '{"items":[]}');
    write(`${g}/cardtable.json`, '{"links":{}}');
    write(`${g}/archive.db`, 'archive');
    write(`${g}/archive.db-wal`, 'wal');
    write(`${g}/general_1100000000000000001/archive_1.json`, '[]');
    write(`tasklist/${g}/tasks.json`, '{"tasks":[]}');
    write('import/manifest.jsonl', '');
    write('log.csv', 'Task\n');
    return g;
}

test('state is everything that is not the archive', () => {
    const g = seed();
    expect(stateItems(root).map((i) => i.key).sort()).toEqual([
        `state/${g}/cardtable.json`,
        `state/${g}/scheduled.json`,
        `state/tasklist/${g}/tasks.json`,
    ]);
});

test('creates, then sends only what changed, by compare-and-swap', async () => {
    const g = seed();
    expect(await syncState(ds, { root })).toMatchObject({ created: 3, updated: 0, failed: 0 });
    expect((await ds.get(`state/${g}/scheduled.json`)).body.toString()).toBe('{"items":[]}');

    expect(await syncState(ds, { root })).toMatchObject({ created: 0, updated: 0, unchanged: 3 });

    write(`${g}/scheduled.json`, '{"items":[{"id":1}]}');
    expect(await syncState(ds, { root })).toMatchObject({ updated: 1, unchanged: 2 });
    const rec = await ds.get(`state/${g}/scheduled.json`);
    expect(rec.body.toString()).toBe('{"items":[{"id":1}]}');
    expect(rec.contentType).toBe('application/json');
});

test('a restart re-checks against the store and sends nothing unchanged', async () => {
    seed();
    await syncState(ds, { root });
    resetConfirmed();
    expect(await syncState(ds, { root })).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
});

test('a write the bot did not make is a logged conflict, then the bot copy wins', async () => {
    const g = seed();
    await syncState(ds, { root });
    const head = await ds.head(`state/${g}/cardtable.json`);
    await ds.put(`state/${g}/cardtable.json`, '{"elsewhere":true}', { ifMatch: head.version });

    write(`${g}/cardtable.json`, '{"links":{"a":1}}');
    expect(await syncState(ds, { root })).toMatchObject({ conflict: 1, updated: 0 });
    expect((await ds.get(`state/${g}/cardtable.json`)).body.toString()).toBe('{"elsewhere":true}');

    expect(await syncState(ds, { root })).toMatchObject({ conflict: 0, updated: 1 });
    expect((await ds.get(`state/${g}/cardtable.json`)).body.toString()).toBe('{"links":{"a":1}}');
});

test('a JSON file caught mid-write is skipped until it parses', async () => {
    const g = seed();
    write(`${g}/scheduled.json`, '{"items":[');
    expect(await syncState(ds, { root })).toMatchObject({ created: 2, unreadable: 1 });
    expect(await ds.head(`state/${g}/scheduled.json`)).toBeNull();
});

test('an unbound key stops the sync instead of failing every file', async () => {
    seed();
    const other = new DataStore({ url: listener.url, key: OTHER_KEY, ns: 'archivebot' });
    try {
        await expect(syncState(other, { root })).rejects.toMatchObject({ status: 403 });
    } finally {
        other.close();
    }
});
