/**
 * A host rebuilt from the store: a real output tree is imported and synced
 * into dataplatform's real listener on a scratch store, wiped, and restored.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DataStore } = require('../lib/dataStore');
const { importAll, loadManifest, isStored } = require('../lib/archiveImport');
const { syncState, stateItems, resetConfirmed } = require('../lib/stateSync');
const { restoreFromStore, restoreNeeded } = require('../lib/storeRestore');
const { repairGuild } = require('../lib/archiveRepair');
const archive = require('../lib/archive');
const permissions = require('../lib/permissions');
const { startDataListener, KEY } = require('./support/dataListener');

const OUT = () => process.env.ARCHIVEBOT_OUTPUT_DIR;
const GUILD = '1200000000000000101';
const BOUND = '1200000000000000102'; // state only, never archived (a cardtable guild)
const CH = '1100000000000000101';
const AUTHOR = '1500000000000000001';

// One store per test: the restore lists the whole namespace.
let listener;
let ds;
beforeEach(async () => {
    listener = await startDataListener();
    ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
    resetConfirmed();
    wipe();
}, 20000);
afterEach(() => {
    ds.close();
    listener.stop();
});

function wipe() {
    for (const e of fs.readdirSync(OUT())) fs.rmSync(path.join(OUT(), e), { recursive: true, force: true });
}

function write(rel, body) {
    const file = path.join(OUT(), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

const att = (id, name, body) => ({ id, name, size: Buffer.byteLength(body), url: `https://cdn/${id}`, contentType: 'image/png' });
const A = att('1400000000000000001', 'cat.png', 'cat bytes');
const B = att('1400000000000000002', 'dog.png', 'dog bytes');

/** A host as the bot leaves it: a channel archived twice under two names, and state. */
async function seedHost() {
    const batch = (folder, ms, msgs) => {
        write(`${GUILD}/${folder}/archive_${ms}.json`, JSON.stringify(msgs.map(([id, ts, atts]) => (
            { id, createdTimestamp: ts, content: `m${id.slice(-1)}`, metadata: { attachments: atts } }))));
        write(`${GUILD}/${folder}/authors_${ms}.json`, JSON.stringify(
            { [AUTHOR]: { id: AUTHOR, username: 'u', msgIds: msgs.map(([id]) => id) } }));
    };
    batch(`general_${CH}`, 1700000000000, [['1300000000000000001', 1700000000000, [A]], ['1300000000000000002', 1700000001000, []]]);
    batch(`chat_${CH}`, 1760000000000, [['1300000000000000003', 1760000000000, [B]]]);
    write(`${GUILD}/general_${CH}/attachments/${archive.attachmentFileName(A)}`, 'cat bytes');
    write(`${GUILD}/chat_${CH}/attachments/${archive.attachmentFileName(B)}`, 'dog bytes');
    await archive.initializeDatabaseIfNeeded(GUILD);
    await archive.ingestOrphanedFiles(GUILD);

    write(`${GUILD}/scheduled.json`, '{"items":[{"id":1,"message":"standup"}]}');
    write(`${BOUND}/cardtable.json`, '{"setup":{"guildId":"x"},"links":{}}');
    write(`tasklist/${GUILD}/tasks.json`, '{"tasks":[{"title":"t"}]}');
    permissions.setPermission(AUTHOR, GUILD, 'admin');
}

function snapshotState() {
    return Object.fromEntries(stateItems().map((i) => [i.key, fs.readFileSync(i.file, 'utf8')]));
}

async function rows(guildId) {
    const db = await open({ filename: path.join(OUT(), guildId, 'archive.db'), driver: sqlite3.Database });
    const r = await db.all('SELECT id, createdTimestamp, content, author_id, channel_id FROM raw_archive ORDER BY id');
    await db.close();
    return r;
}

test('per-guild config lives under the output root, so it is state', async () => {
    permissions.setPermission(AUTHOR, GUILD, 'admin');
    expect(stateItems().map((i) => i.key)).toContain(`state/Resources/${GUILD}/permissions.json`);
});

test('a wiped host comes back with its state, its archive index and the store as its manifest', async () => {
    await seedHost();
    expect(await importAll(ds)).toMatchObject({ conflict: 0, failed: 0 });
    expect(await syncState(ds)).toMatchObject({ created: 4, failed: 0 });
    const state = snapshotState();
    const before = await rows(GUILD);
    const last = await archive.getLastArchiveTime(GUILD, CH);
    expect(before).toHaveLength(3);

    wipe();
    expect(restoreNeeded()).toEqual(['state', 'archive', 'manifest']);
    const counts = await restoreFromStore(ds);

    expect(counts).toMatchObject({ state: 4, guilds: 1, files: 4, messages: 3 });
    expect(snapshotState()).toEqual(state);
    expect(permissions.isAdmin(AUTHOR, GUILD)).toBe(true);
    expect(await rows(GUILD)).toEqual(before);
    // Archiving resumes where it stopped, not from the beginning.
    expect(await archive.getLastArchiveTime(GUILD, CH)).toBe(last);

    // Attachments stay in the store, and the repair counts them as held.
    expect(fs.existsSync(path.join(OUT(), GUILD, `chat_${CH}`, 'attachments'))).toBe(false);
    const manifest = loadManifest();
    for (const a of [A, B]) {
        const msg = a === A ? '1300000000000000001' : '1300000000000000003';
        expect(isStored(manifest.get(`${GUILD}/${CH}/attachments/${msg}/${a.id}`))).toBe(true);
    }
    const repair = await repairGuild(GUILD, { apply: false });
    expect(repair).toMatchObject({ stored: 2, recover: 0 });

    // Whole again: the next start asks the store nothing.
    expect(restoreNeeded()).toEqual([]);
});

test('a host that has its files starts with the store unreachable', async () => {
    await seedHost();
    await importAll(ds);
    await syncState(ds);
    const down = new DataStore({ url: 'http://127.0.0.1:9', key: KEY, ns: 'archivebot' });
    try {
        // The never-archived guild holds no channel folders, so it needs nothing.
        expect(restoreNeeded()).toEqual([]);
        expect(await restoreFromStore(down)).toEqual({ state: 0, guilds: 0, files: 0, messages: 0, manifest: 0 });
    } finally {
        down.close();
    }
});

test('a fresh host that cannot reach the store refuses, and stays fresh', async () => {
    const down = new DataStore({ url: 'http://127.0.0.1:9', key: KEY, ns: 'archivebot' });
    try {
        await expect(restoreFromStore(down)).rejects.toThrow();
    } finally {
        down.close();
    }
    expect(fs.readdirSync(OUT())).toEqual([]);
});

test('a restore cut short in the state leaves no state, so the next start retries it', async () => {
    await seedHost();
    await importAll(ds);
    await syncState(ds);
    wipe();

    let gets = 0;
    const flaky = Object.create(ds);
    flaky.get = async (key) => {
        if (key.startsWith('state/') && ++gets === 3) throw new Error('connection reset');
        return ds.get(key);
    };
    await expect(restoreFromStore(flaky)).rejects.toThrow('connection reset');
    expect(stateItems()).toEqual([]);
    expect(restoreNeeded()).toContain('state');

    expect(await restoreFromStore(ds)).toMatchObject({ state: 4 });
    expect(restoreNeeded()).toEqual([]);
});
