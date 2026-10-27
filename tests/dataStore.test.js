/**
 * lib/dataStore.js against dataplatform's REAL data listener: the deployed
 * checkout's code on a scratch store (tests/support/scratch_data_listener.py).
 * Only identity is substituted, through dataplatform's own hermetic hook
 * WHOAMI_TEST_OVERRIDES. It never touches the live store.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DataStore, DataError } = require('../lib/dataStore');
const { startDataListener, KEY, OTHER_KEY } = require('./support/dataListener');

let listener;
let root;
let url;

beforeAll(async () => {
    listener = await startDataListener();
    ({ url, root } = listener);
}, 20000);

afterAll(() => listener?.stop());

const store = () => new DataStore({ url, key: KEY, ns: 'archivebot' });
let ds;
beforeEach(() => { ds = store(); });
afterEach(() => ds.close());

test('create-only PUT, then GET and HEAD agree with what was sent', async () => {
    const body = Buffer.from(JSON.stringify([{ id: '1' }]));
    const rec = await ds.put('g/c/batches/1.json', body, { createOnly: true, contentType: 'application/json' });
    expect(rec.size).toBe(body.length);
    expect(rec.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));

    const got = await ds.get('g/c/batches/1.json');
    expect(got.body).toEqual(body);
    expect(got.contentType).toBe('application/json');

    const head = await ds.head('g/c/batches/1.json');
    expect(head).toMatchObject({ size: body.length, sha256: rec.sha256, version: rec.version });
});

test('a second create-only PUT is refused with 412', async () => {
    await ds.put('g/c/batches/2.json', 'a', { createOnly: true });
    await expect(ds.put('g/c/batches/2.json', 'b', { createOnly: true }))
        .rejects.toMatchObject({ name: 'DataError', status: 412 });
});

test('HEAD and GET of an absent key are null', async () => {
    expect(await ds.head('g/c/nope')).toBeNull();
    expect(await ds.get('g/c/nope')).toBeNull();
});

test('putFile streams a large file and the store hashes it the same', async () => {
    const file = path.join(root, 'big.bin');
    const chunk = crypto.randomBytes(1 << 20);
    const fd = fs.openSync(file, 'w');
    for (let i = 0; i < 70; i++) fs.writeSync(fd, chunk); // 70 MiB: past the old 64 MiB cap
    fs.closeSync(fd);
    const want = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

    const rec = await ds.putFile('g/c/attachments/m/a', file, { createOnly: true, contentType: 'video/mp4' });
    expect(rec).toMatchObject({ size: 70 << 20, sha256: want });
    expect(await ds.head('g/c/attachments/m/a')).toMatchObject({ size: 70 << 20, sha256: want, contentType: 'video/mp4' });
}, 60000);

test('a sha256 that does not match the bytes is refused and nothing is stored', async () => {
    const file = path.join(root, 'small.bin');
    fs.writeFileSync(file, 'real bytes');
    await expect(ds.putFile('g/c/attachments/m/bad', file, { createOnly: true, sha256: '0'.repeat(64) }))
        .rejects.toMatchObject({ status: 422 });
    expect(await ds.head('g/c/attachments/m/bad')).toBeNull();
});

test('append creates, then appends atomically', async () => {
    await ds.append('log.csv', 'Task,GuildId\n');
    await ds.append('log.csv', 'archive,1\n');
    expect((await ds.get('log.csv')).body.toString()).toBe('Task,GuildId\narchive,1\n');
});

describe('appendOnce', () => {
    // The append reaches the store, then its connection dies before the answer:
    // the client's retry is the request that used to land twice.
    function dropFirstAppendAnswer(target) {
        const real = target._once.bind(target);
        let dropped = false;
        target._once = async (method, p, opts) => {
            const res = await real(method, p, opts);
            if (method === 'POST' && !dropped) {
                dropped = true;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            }
            return res;
        };
    }

    test('a retry after a landed append does not append again', async () => {
        await ds.append('once/log.csv', 'Task\n');
        const plain = store();
        dropFirstAppendAnswer(plain);
        await plain.append('once/log.csv', 'plain,1\n');
        plain.close();
        // The gap this closes: the bare append's retry landed a second copy.
        expect((await ds.get('once/log.csv')).body.toString()).toBe('Task\nplain,1\nplain,1\n');

        dropFirstAppendAnswer(ds);
        await ds.appendOnce('once/log.csv', 'archive,2\n');
        expect((await ds.get('once/log.csv')).body.toString()).toBe('Task\nplain,1\nplain,1\narchive,2\n');
    });

    test('another writer in between is contention, and both lines land once', async () => {
        await ds.append('race/log.csv', 'Task\n');
        const other = store();
        const realHead = ds.head.bind(ds);
        let raced = false;
        ds.head = async (key) => {
            const h = await realHead(key);
            if (!raced) {
                raced = true;
                await other.append(key, 'other,1\n');
            }
            return h;
        };
        await ds.appendOnce('race/log.csv', 'mine,1\n');
        other.close();
        expect((await ds.get('race/log.csv')).body.toString()).toBe('Task\nother,1\nmine,1\n');
    });

    test('an absent record is left absent', async () => {
        expect(await ds.appendOnce('absent/log.csv', 'x\n')).toBeNull();
        expect(await ds.head('absent/log.csv')).toBeNull();
    });
});

test('list pages through every record under a prefix in key order', async () => {
    for (let i = 0; i < 7; i++) await ds.put(`list/k${i}`, String(i), { createOnly: true });
    const seen = [];
    for await (const item of ds.list('list/', { limit: 3 })) seen.push(item.path);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `list/k${i}`));
});

test('keys with spaces and unicode are encoded, not mangled', async () => {
    const key = 'g/c/legacy/✧ music ✧ #1.png';
    await ds.put(key, 'x', { createOnly: true });
    expect((await ds.get(key)).body.toString()).toBe('x');
});

test('an unbound key is a 403, the pending-binding case', async () => {
    const other = new DataStore({ url, key: OTHER_KEY, ns: 'archivebot' });
    try {
        await expect(other.head('anything')).rejects.toBeInstanceOf(DataError);
        await expect(other.head('anything')).rejects.toMatchObject({ status: 403 });
    } finally {
        other.close();
    }
});

test('a refused connection is retried for the window, then surfaces', async () => {
    const net = require('net');
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const late = new DataStore({ url: `http://127.0.0.1:${port}`, key: KEY, ns: 'archivebot' });
    // Nothing listens on that port: the retry window runs out and the error surfaces.
    const t0 = Date.now();
    await expect(late.head('x')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);
    late.close();
}, 15000);
