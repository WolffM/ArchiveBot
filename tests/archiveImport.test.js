/**
 * The import, against dataplatform's real listener on a scratch store, from a
 * real Output/ tree under the per-file state root.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DataStore } = require('../lib/dataStore');
const { importAll, loadManifest, isStored } = require('../lib/archiveImport');
const archive = require('../lib/archive');
const { startDataListener, KEY, OTHER_KEY } = require('./support/dataListener');

// The scratch store lives for the whole file, so each test gets a guild of its own.
let guildSeq = 70;
let GUILD;
const CH = '1100000000000000077';
const OUT = () => process.env.ARCHIVEBOT_OUTPUT_DIR;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let listener;
beforeAll(async () => { listener = await startDataListener(); }, 20000);
afterAll(() => listener?.stop());

let ds;
beforeEach(async () => {
    GUILD = `12000000000000000${guildSeq++}`;
    ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
    fs.rmSync(path.join(OUT(), GUILD), { recursive: true, force: true });
    fs.rmSync(path.join(OUT(), 'import'), { recursive: true, force: true });
});
afterEach(() => {
    ds.close();
    fs.rmSync(path.join(OUT(), GUILD), { recursive: true, force: true });
});

// One channel, renamed once: two folders for one id. image.png collided (the
// later one survives by name), notes.txt did not, old.gif has no record, and
// one attachment already has its id name.
async function seed() {
    const a = (id, name, body) => ({ id, name, size: Buffer.byteLength(body), url: `https://cdn/${id}`, contentType: 'image/png' });
    const A = a('1400000000000000001', 'image.png', 'first');
    const C = a('1400000000000000003', 'image.png', 'the third one');
    const N = a('1400000000000000004', 'notes.txt', 'notes');
    const D = a('1400000000000000005', 'done.png', 'already id-named');
    const oldFolder = path.join(OUT(), GUILD, `general_${CH}`);
    const newFolder = path.join(OUT(), GUILD, `chat_${CH}`);
    for (const f of [oldFolder, newFolder]) fs.mkdirSync(path.join(f, 'attachments'), { recursive: true });
    const write = (folder, file, msgs) => fs.writeFileSync(path.join(folder, file), JSON.stringify(
        msgs.map(([id, atts]) => ({ id, createdTimestamp: 0, content: '', metadata: { attachments: atts } }))));
    write(oldFolder, 'archive_100.json', [['1300000000000000001', [A]], ['1300000000000000003', [C, N]]]);
    fs.writeFileSync(path.join(oldFolder, 'authors_100.json'), '{}');
    fs.writeFileSync(path.join(oldFolder, 'attachments', 'image.png'), 'the third one');
    fs.writeFileSync(path.join(oldFolder, 'attachments', 'notes.txt'), 'notes');
    fs.writeFileSync(path.join(oldFolder, 'attachments', 'old.gif'), 'legacy bytes');
    // A was recovered, but Discord served other bytes than its recorded size.
    fs.mkdirSync(path.join(oldFolder, 'attachments-mismatch'));
    fs.writeFileSync(path.join(oldFolder, 'attachments-mismatch', archive.attachmentFileName(A)), 'first, re-encoded');
    write(newFolder, 'archive_200.json', [['1300000000000000005', [D]]]);
    fs.writeFileSync(path.join(newFolder, 'attachments', archive.attachmentFileName(D)), 'already id-named');
    fs.writeFileSync(path.join(OUT(), 'log.csv'), 'Task,GuildId,ChannelID,Timestamp\n');

    await archive.initializeDatabaseIfNeeded(GUILD);
    const db = await open({ filename: path.join(OUT(), GUILD, 'archive.db'), driver: sqlite3.Database });
    await db.run("INSERT INTO raw_archive (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata) VALUES ('1300000000000000001', 0, 'hi', '1', ?, ?, 'general', 'archive_100.json', '{}')", [GUILD, CH]);
    await db.close();
    return { oldFolder, newFolder };
}

async function keys(prefix = '') {
    const out = [];
    for await (const item of ds.list(prefix)) out.push(item.path);
    return out;
}

test('every file lands under its id key with the same bytes', async () => {
    const { oldFolder } = await seed();
    const counts = await importAll(ds, { now: new Date('2026-10-26T00:00:00Z') });
    expect(counts).toMatchObject({ conflict: 0, failed: 0 });

    const base = `${GUILD}/${CH}`;
    expect(await keys(`${base}/`)).toEqual([
        `${base}/attachments-mismatch/1300000000000000001/1400000000000000001`,
        `${base}/attachments/1300000000000000003/1400000000000000003`,
        `${base}/attachments/1300000000000000003/1400000000000000004`,
        `${base}/attachments/1300000000000000005/1400000000000000005`,
        `${base}/authors/100.json`,
        `${base}/batches/100.json`,
        `${base}/batches/200.json`,
        `${base}/legacy/general_${CH}/old.gif`,
        `${base}/names/chat_${CH}`,
        `${base}/names/general_${CH}`,
    ]);
    // The overwritten first image.png is only there as what Discord serves now.
    expect((await ds.get(`${base}/attachments-mismatch/1300000000000000001/1400000000000000001`)).body.toString())
        .toBe('first, re-encoded');
    const third = await ds.get(`${base}/attachments/1300000000000000003/1400000000000000003`);
    expect(third.body.toString()).toBe('the third one');
    expect(third.contentType).toBe('image/png');
    expect((await ds.get(`${base}/batches/100.json`)).body)
        .toEqual(fs.readFileSync(path.join(oldFolder, 'archive_100.json')));
    expect((await ds.get('log.csv')).body.toString()).toBe('Task,GuildId,ChannelID,Timestamp\n');

    // The snapshot is a real database with the live rows.
    const snap = await ds.get(`${GUILD}/snapshots/archive-2026-10-26.db`);
    const snapFile = path.join(OUT(), 'snap-check.db');
    fs.writeFileSync(snapFile, snap.body);
    const db = await open({ filename: snapFile, driver: sqlite3.Database });
    expect(await db.get('SELECT content FROM raw_archive')).toEqual({ content: 'hi' });
    await db.close();
    expect(fs.existsSync(path.join(OUT(), 'import', `${GUILD}-snapshot.db`))).toBe(false);

    // The manifest records every local file with the hash the store confirmed.
    const manifest = loadManifest();
    const entry = manifest.get(`${base}/legacy/general_${CH}/old.gif`);
    expect(entry).toMatchObject({ status: 'uploaded', sha256: sha('legacy bytes'), storeSha256: sha('legacy bytes') });
    expect([...manifest.values()].some((e) => e.key.includes('/snapshots/'))).toBe(false);
});

test('a re-run uploads nothing and hashes nothing it already verified', async () => {
    await seed();
    await importAll(ds);
    const again = await importAll(ds);
    expect(again).toMatchObject({ uploaded: 0, conflict: 0, failed: 0 });
    expect(again.skipped).toBeGreaterThan(0);
});

test('a key the store holds with other bytes is a conflict, not an overwrite', async () => {
    const { oldFolder } = await seed();
    await ds.put(`${GUILD}/${CH}/batches/100.json`, 'something else', { createOnly: true });
    const counts = await importAll(ds);
    expect(counts.conflict).toBe(1);
    expect((await ds.get(`${GUILD}/${CH}/batches/100.json`)).body.toString()).toBe('something else');
    expect(fs.existsSync(path.join(oldFolder, 'archive_100.json'))).toBe(true);
});

test('an unbound key fails before uploading anything', async () => {
    await seed();
    const other = new DataStore({ url: listener.url, key: OTHER_KEY, ns: 'archivebot' });
    try {
        await expect(importAll(other)).rejects.toMatchObject({ status: 403 });
    } finally {
        other.close();
    }
    expect(await keys(`${GUILD}/`)).toEqual([]);
});

describe('runImport, as the bot schedules it', () => {
    const { runImport } = require('../lib/archiveImport');

    test('unbound: retry in ten minutes', async () => {
        await seed();
        const other = new DataStore({ url: listener.url, key: OTHER_KEY, ns: 'archivebot' });
        try {
            expect(await runImport(other)).toBe(10 * 60 * 1000);
        } finally {
            other.close();
        }
    });

    test('bound: sweep again tomorrow', async () => {
        await seed();
        expect(await runImport(ds)).toBe(24 * 60 * 60 * 1000);
    });
});

describe('scripts/prune-imported.js', () => {
    const { execFileSync } = require('child_process');
    const prune = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'prune-imported.js'), ...args], {
        env: { ...process.env, LOG_LEVEL: 'ERROR' },
    }).toString());

    test('deletes only store-verified attachments whose bytes still match', async () => {
        const { oldFolder, newFolder } = await seed();
        await importAll(ds);
        // Changed after the import: its store copy no longer matches, so it stays.
        fs.writeFileSync(path.join(oldFolder, 'attachments', 'notes.txt'), 'edited later');

        expect(prune()).toMatchObject({ apply: false, wouldDelete: 4, deleted: 0 });
        expect(fs.existsSync(path.join(oldFolder, 'attachments', 'old.gif'))).toBe(true);

        expect(prune('--apply')).toMatchObject({ apply: true, deleted: 4, kept: { 'changed since import': 1 } });
        expect(fs.readdirSync(path.join(oldFolder, 'attachments'))).toEqual(['notes.txt']);
        expect(fs.existsSync(path.join(oldFolder, 'attachments-mismatch'))).toBe(false);
        expect(fs.existsSync(path.join(newFolder, 'attachments'))).toBe(false);
        // The cache stays.
        expect(fs.existsSync(path.join(oldFolder, 'archive_100.json'))).toBe(true);
        expect(fs.existsSync(path.join(oldFolder, 'authors_100.json'))).toBe(true);
        expect(fs.existsSync(path.join(OUT(), GUILD, 'archive.db'))).toBe(true);
    });

    test('a repair after the prune re-downloads nothing the store holds', async () => {
        const { oldFolder } = await seed();
        await importAll(ds);
        fs.writeFileSync(path.join(oldFolder, 'attachments', 'notes.txt'), 'edited later');
        prune('--apply');

        // The next daily import no longer sees the pruned files; the manifest keeps them.
        // The only upload is the edited notes.txt: it no longer matches its record, so it is unrecorded.
        expect(await importAll(ds)).toMatchObject({ uploaded: 1, conflict: 0, failed: 0 });
        expect(loadManifest().get(`${GUILD}/${CH}/legacy/general_${CH}/notes.txt`)).toMatchObject({ status: 'uploaded' });
        const carried = loadManifest().get(`${GUILD}/${CH}/attachments/1300000000000000005/1400000000000000005`);
        expect(carried).toMatchObject({ sha256: sha('already id-named'), storeSha256: sha('already id-named') });
        expect(isStored(carried)).toBe(true);

        const rest = { post: jest.fn() };
        const t = await require('../lib/archiveRepair').repairGuild(GUILD, { rest, apply: true });
        // A (as its mismatch), C, D, and notes.txt, whose local copy was edited:
        // the store holds the bytes that were imported.
        expect(t).toMatchObject({ stored: 4, recover: 0, recovered: 0, failed: 0 });
        expect(rest.post).not.toHaveBeenCalled();
    });
});
