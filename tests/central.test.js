/**
 * The off-node contract (lib/central.js, lib/heldLease.js, lib/reconcile.js,
 * the DataStore fence), against dataplatform's REAL listener on a scratch
 * store: its leases, fences and change feed are the thing under test.
 * Discord is a fake; nothing logs in anywhere.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DataStore, LeaseNotHeld } = require('../lib/dataStore');
const { Central, bootCentral, handleLeaseLost, centralMode, LEASE_LOST_EXIT } = require('../lib/central');
const { reconcileState, reconcileArchive, CentralRefusal } = require('../lib/reconcile');
const { syncState, resetConfirmed } = require('../lib/stateSync');
const { createHandler } = require('../lib/webhookServer');
const { startDataListener, KEY } = require('./support/dataListener');

// One store per test: leases and the change feed are namespace-wide.
let listener;
let root;
const open = [];
function store(opts = {}) {
    const ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot', ...opts });
    open.push(ds);
    return ds;
}
const centrals = [];
function central(opts = {}) {
    const c = new Central({ ds: store(), ttlS: 3, pollMs: 50, holder: `test-${centrals.length}`, ...opts });
    centrals.push(c);
    return c;
}

beforeEach(async () => {
    listener = await startDataListener();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivebot-central-'));
    resetConfirmed();
}, 20000);
afterEach(async () => {
    for (const c of centrals.splice(0)) await c.stop().catch(() => {});
    for (const ds of open.splice(0)) ds.close();
    listener.stop();
    fs.rmSync(root, { recursive: true, force: true });
});

function write(rel, body) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const until = async (cond, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 20));
    }
};

function get(handler, urlPath) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    server.close();
                    resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                });
            }).on('error', (err) => { server.close(); reject(err); });
        });
    });
}

describe('the switch', () => {
    test('on-node unless ARCHIVEBOT_STATE_STORE=central; HADOKU_DATA_URL alone does not flip it', () => {
        expect(centralMode({})).toBe(false);
        expect(centralMode({ HADOKU_DATA_URL: 'http://x', HADOKU_SERVICE_KEY: 'k' })).toBe(false);
        expect(centralMode({ ARCHIVEBOT_STATE_STORE: 'central', HADOKU_DATA_URL: 'http://x', HADOKU_SERVICE_KEY: 'k' })).toBe(true);
        expect(() => centralMode({ ARCHIVEBOT_STATE_STORE: 'central' })).toThrow(/HADOKU_DATA_URL/);
        expect(() => centralMode({ ARCHIVEBOT_STATE_STORE: 'shared' })).toThrow(/'local' or 'central'/);
    });
});

describe('boot order', () => {
    test('login runs only once the lease is held and reconcile has run; a second process waits without logging in', async () => {
        const first = central();
        const seen = [];
        const login1 = jest.fn(async () => { seen.push({ token: first.token(), phase: first.phase() }); });
        await bootCentral({ central: first, reconcile: async () => ({ ok: 1 }), login: login1 });
        expect(login1).toHaveBeenCalledTimes(1);
        expect(seen[0].token).toEqual(expect.any(Number));
        expect(seen[0].phase).toBe('starting');
        expect(await store().leaseInfo('state/')).toMatchObject({ held: true, holder: 'test-0' });

        const second = central();
        const login2 = jest.fn(async () => {});
        const booting = bootCentral({ central: second, reconcile: async () => ({}), login: login2 });
        await new Promise((r) => setTimeout(r, 400));
        expect(login2).not.toHaveBeenCalled();
        expect(second.phase()).toBe('standby');
        expect(second.token()).toBeNull();

        // The holder hands the lease back: the standby takes over and only then logs in.
        await first.stop();
        await booting;
        expect(login2).toHaveBeenCalledTimes(1);
        expect(second.token()).toEqual(expect.any(Number));
    });

    test('a refused reconcile never logs in, and hands the lease back', async () => {
        const c = central();
        const login = jest.fn();
        await expect(bootCentral({
            central: c,
            reconcile: async () => { throw new CentralRefusal('no'); },
            login,
        })).rejects.toBeInstanceOf(CentralRefusal);
        expect(login).not.toHaveBeenCalled();
        expect(c.phase()).toBe('refused');
        expect(await store().leaseInfo('state/')).toMatchObject({ held: false });
    });
});

describe('the fence', () => {
    test('every write under state/ carries the token, nothing outside it does, and none leaves without the lease', async () => {
        const seen = [];
        const stub = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, token: req.headers['x-lease-token'] });
                res.writeHead(req.method === 'DELETE' ? 200 : 201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ version: 1, sha256: 'x' }));
            });
        });
        await new Promise((r) => stub.listen(0, '127.0.0.1', r));
        let token = 41;
        const ds = new DataStore({
            url: `http://127.0.0.1:${stub.address().port}`, key: KEY, ns: 'archivebot',
            fence: { prefix: 'state/', token: () => token, onRefused: () => {} },
        });
        try {
            write('f.json', '{}');
            await ds.put('state/a.json', '{}', { createOnly: true });
            await ds.putFile('state/b.json', path.join(root, 'f.json'), { ifMatch: 3 });
            await ds.append('state/c.jsonl', 'x\n');
            await ds.delete('state/d.json', { ifMatch: 2 });
            await ds.put('1/2/batches/3.json', '[]', { createOnly: true });
            expect(seen.map((s) => [s.method, s.token])).toEqual([
                ['PUT', '41'], ['PUT', '41'], ['POST', '41'], ['DELETE', '41'], ['PUT', undefined],
            ]);

            token = null;
            seen.length = 0;
            await expect(ds.put('state/a.json', '{}', { ifMatch: 1 })).rejects.toBeInstanceOf(LeaseNotHeld);
            await expect(ds.put('1/2/batches/4.json', '[]', { createOnly: true })).rejects.toBeInstanceOf(LeaseNotHeld);
            await expect(ds.append('log.csv', 'x\n')).rejects.toBeInstanceOf(LeaseNotHeld);
            await expect(ds.delete('state/d.json', { ifMatch: 2 })).rejects.toBeInstanceOf(LeaseNotHeld);
            expect(seen).toEqual([]);
        } finally {
            ds.close();
            stub.close();
        }
    });

    test('the real store refuses a tokenless state write under the lease; the fenced store gets through', async () => {
        const c = central();
        await c.acquire();
        await expect(store().put('state/x.json', '{}', { createOnly: true })).rejects.toMatchObject({ status: 423 });
        const fenced = store({ fence: c.fence() });
        await expect(fenced.put('state/x.json', '{}', { createOnly: true })).resolves.toMatchObject({ version: expect.any(Number) });

        write('7/scheduled.json', '{"items":[]}');
        expect(await syncState(fenced, { root })).toMatchObject({ created: 1, failed: 0 });
    });
});

describe('losing the lease', () => {
    test('a refused renewal stops the writers, destroys the client and exits 75; later writes are never sent', async () => {
        const c = central({ ttlS: 1 });
        const stopWriters = jest.fn();
        const client = { destroy: jest.fn() };
        const server = { close: jest.fn() };
        const exit = jest.fn();
        c.onLost = (why) => handleLeaseLost({ why, stopWriters, client, server, exit });
        await c.acquire();
        const token = c.token();

        // Someone revokes it under us (the same thing a lapse looks like to the store).
        await store().releaseLease('state/', token);
        await until(() => exit.mock.calls.length > 0);

        expect(exit).toHaveBeenCalledWith(LEASE_LOST_EXIT);
        expect(LEASE_LOST_EXIT).toBe(75);
        expect(stopWriters).toHaveBeenCalled();
        expect(client.destroy).toHaveBeenCalled();
        expect(server.close).toHaveBeenCalled();
        expect(c.phase()).toBe('lost');
        expect(c.token()).toBeNull();

        const fenced = store({ fence: c.fence() });
        await expect(fenced.put('state/late.json', '{}', { createOnly: true })).rejects.toBeInstanceOf(LeaseNotHeld);
        expect(await store().head('state/late.json')).toBeNull();
    });

    test('a write the store refuses as lease_lost ends the process at once, without waiting for a renewal', async () => {
        const c = central({ ttlS: 30 });
        const exit = jest.fn();
        c.onLost = (why) => handleLeaseLost({ why, stopWriters: () => {}, client: { destroy() {} }, exit });
        await c.acquire();
        const other = store();
        await other.releaseLease('state/', c.token());
        // A new holder takes it: the old token is dead.
        await other.acquireLease('state/', { ttl: 30 });

        const fenced = store({ fence: c.fence() });
        await expect(fenced.put('state/y.json', '{}', { createOnly: true })).rejects.toMatchObject({ status: 409, reason: 'lease_lost' });
        expect(exit).toHaveBeenCalledWith(75);
        expect(await other.head('state/y.json')).toBeNull();
    });

    test('a store that stops answering is a lost lease within one TTL', async () => {
        const c = central({ ttlS: 1 });
        const exit = jest.fn();
        c.onLost = (why) => handleLeaseLost({ why, stopWriters: () => {}, client: { destroy() {} }, exit });
        await c.acquire();
        listener.stop();
        await until(() => exit.mock.calls.length > 0, 4000);
        expect(c.status().reason).toMatch(/no renewal confirmed/);
        listener = await startDataListener(); // for afterEach
    }, 15000);
});

describe('/health follows the lease', () => {
    test('503 waiting shapes until active, then 200 with central.state active and committed_s_ago', async () => {
        const c = central();
        let ready = false;
        const handler = createHandler({ discordClient: { isReady: () => ready }, eventsSecret: 's', central: c, commit: 'abc' });

        const waiting = await get(handler, '/health');
        // Nothing has polled the lease yet, so the holder is not known: omitted.
        expect(waiting).toEqual({ status: 503, body: { detail: { central: { state: 'standby', self: 'test-0' } } } });
        // Every route waits, not only /health.
        expect((await get(handler, '/api/messages/recent?channel=general')).status).toBe(503);

        await c.acquire();
        let during = null;
        await c.reconcile(async () => { during = await get(handler, '/health'); });
        expect(during.status).toBe(503);
        expect(during.body.detail.central.state).toBe('reconciling');

        const starting = await get(handler, '/health');
        expect(starting.status).toBe(503);
        expect(starting.body.detail.central.state).toBe('starting');

        ready = true;
        c.serving();
        const active = await get(handler, '/health');
        expect(active.status).toBe(200);
        expect(active.body).toEqual({
            status: 'ok', service: 'archive-bot', commit: 'abc', discord: 'ready',
            central: { state: 'active', self: 'test-0', holder: 'test-0', committed_s_ago: expect.any(Number) },
        });
    });

    test('a standby reports itself as self and the node that holds the lease as holder', async () => {
        const first = central({ holder: 'node-a' });
        await first.acquire();
        const second = central({ holder: 'node-b' });
        const handler = createHandler({ discordClient: { isReady: () => false }, central: second, commit: 'abc' });

        const waiting = second.acquire();
        await until(() => second.status().holder !== undefined);
        const res = await get(handler, '/health');
        expect(res).toEqual({ status: 503, body: { detail: { central: { state: 'standby', self: 'node-b', holder: 'node-a' } } } });
        expect(first.status()).toMatchObject({ self: 'node-a', holder: 'node-a' });

        // The holder hands it back: the standby takes it and now names itself.
        await first.stop();
        await waiting;
        expect(second.status()).toMatchObject({ self: 'node-b', holder: 'node-b' });
    });

    test('a standby never names itself the holder, even behind its own unlapsed lease', async () => {
        // A previous process on this node still holds the lease under this node's name.
        await store().acquireLease('state/', { ttl: 30, holder: 'node-a' });
        const c = central({ holder: 'node-a' });
        let polled = 0;
        const realInfo = c.ds.leaseInfo.bind(c.ds);
        c.ds.leaseInfo = async (prefix) => { const info = await realInfo(prefix); polled += 1; return info; };
        c.acquire().catch(() => {});
        await until(() => polled >= 2);
        expect(c.status()).toEqual({ state: 'standby', self: 'node-a' });
    });

    test('on-node, /health is as it was: no central block, the service named', async () => {
        const handler = createHandler({ discordClient: { isReady: () => true }, commit: 'abc' });
        expect(await get(handler, '/health')).toEqual({ status: 200, body: { status: 'ok', service: 'archive-bot', commit: 'abc', discord: 'ready' } });
    });
});

describe('reconcile', () => {
    test('an EMPTY store beside a full state tree refuses, and touches nothing', async () => {
        write('7/scheduled.json', '{"items":[1]}');
        await expect(reconcileState(store(), { root })).rejects.toBeInstanceOf(CentralRefusal);
        expect(read('7/scheduled.json')).toBe('{"items":[1]}');
        expect(fs.existsSync(path.join(root, '.central'))).toBe(false);
    });

    test('an empty store and an empty tree is a first start, not a refusal', async () => {
        await expect(reconcileState(store(), { root })).resolves.toEqual({ same: 0, downloaded: 0, orphaned: 0 });
    });

    test('the store wins: missing and different files come down, local-only files go to orphans, never deleted', async () => {
        const ds = store();
        await ds.put('state/7/scheduled.json', '{"items":["store"]}', { createOnly: true });
        await ds.put('state/7/cardtable.json', '{"links":{}}', { createOnly: true });
        await ds.put('state/tasklist/7/tasks.json', '{"tasks":[]}', { createOnly: true });
        write('7/scheduled.json', '{"items":["local"]}');
        write('7/cardtable.json', '{"links":{}}');
        write('7/spaces.json', '{"only":"here"}');

        const at = new Date('2026-11-03T12:00:00Z');
        expect(await reconcileState(ds, { root, now: at })).toEqual({ same: 1, downloaded: 2, orphaned: 2 });
        expect(read('7/scheduled.json')).toBe('{"items":["store"]}');
        expect(read('tasklist/7/tasks.json')).toBe('{"tasks":[]}');
        expect(fs.existsSync(path.join(root, '7/spaces.json'))).toBe(false);
        const orphans = path.join(root, '.central', 'orphans', '2026-11-03T12-00-00-000Z');
        expect(fs.readFileSync(path.join(orphans, '7/spaces.json'), 'utf8')).toBe('{"only":"here"}');
        expect(fs.readFileSync(path.join(orphans, '7/scheduled.json'), 'utf8')).toBe('{"items":["local"]}');

        // The orphans are not state: nothing syncs them back up.
        const c = central();
        await c.acquire();
        const fenced = store({ fence: c.fence() });
        expect(await syncState(fenced, { root, deletes: true })).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 3 });
    });

    test('after reconcile the sync swaps against the store, and a file the bot removed becomes a tombstone', async () => {
        const ds = store();
        await ds.put('state/7/scheduled.json', '{"items":[]}', { createOnly: true });
        await ds.put('state/7/spaces.json', '{}', { createOnly: true });
        await reconcileState(ds, { root });
        const c = central();
        await c.acquire();
        const fenced = store({ fence: c.fence() });

        write('7/scheduled.json', '{"items":[1]}');
        fs.rmSync(path.join(root, '7/spaces.json'));
        expect(await syncState(fenced, { root, deletes: true })).toMatchObject({ updated: 1, deleted: 1, conflict: 0, failed: 0 });
        expect((await ds.get('state/7/scheduled.json')).body.toString()).toBe('{"items":[1]}');
        expect(await ds.head('state/7/spaces.json')).toBeNull();

        // Re-created later: a create, not a conflict.
        write('7/spaces.json', '{"again":1}');
        expect(await syncState(fenced, { root, deletes: true })).toMatchObject({ created: 1, conflict: 0 });
    });

    test('archive records the store gained come down through the change feed, once', async () => {
        const ds = store();
        const G = '1200000000000000101';
        const CH = '1100000000000000101';
        await ds.put(`${G}/${CH}/names/general_${CH}`, `general_${CH}`, { createOnly: true });
        await ds.put(`${G}/${CH}/batches/1700000000000.json`, '[{"id":"1"}]', { createOnly: true });
        await ds.put(`${G}/${CH}/authors/1700000000000.json`, '{}', { createOnly: true });
        await ds.put(`${G}/${CH}/attachments/1/2`, 'bytes', { createOnly: true });
        // Already here under the channel's current local folder name.
        write(`${G}/renamed_${CH}/archive_1600000000000.json`, '[]');
        await ds.put(`${G}/${CH}/batches/1600000000000.json`, '[]', { createOnly: true });

        const ingest = jest.fn(async () => {});
        const first = await reconcileArchive(ds, { root, ingest });
        expect(first.fetched).toBe(2);
        expect(ingest).toHaveBeenCalledWith(G);
        expect(read(`${G}/renamed_${CH}/archive_1700000000000.json`)).toBe('[{"id":"1"}]');
        expect(read(`${G}/renamed_${CH}/authors_1700000000000.json`)).toBe('{}');
        expect(fs.existsSync(path.join(root, G, `renamed_${CH}`, 'attachments'))).toBe(false);

        // Warm: only what moved since the cursor.
        ingest.mockClear();
        expect((await reconcileArchive(ds, { root, ingest })).fetched).toBe(0);
        expect(ingest).not.toHaveBeenCalled();
        await ds.put(`${G}/${CH}/batches/1800000000000.json`, '[]', { createOnly: true });
        expect((await reconcileArchive(ds, { root, ingest })).fetched).toBe(1);
    });

    test('a renamed channel holds records in each of its folders; none is fetched again into another', async () => {
        const ds = store();
        const G = '1200000000000000102';
        const CH = '1100000000000000102';
        // As production: the channel was archived as old_ then as new_, and both folders stayed.
        write(`${G}/old_${CH}/archive_1600000000000.json`, '[]');
        write(`${G}/old_${CH}/authors_1600000000000.json`, '{}');
        write(`${G}/new_${CH}/archive_1700000000000.json`, '[]');
        for (const [key, body] of [
            [`${G}/${CH}/names/old_${CH}`, `old_${CH}`],
            [`${G}/${CH}/names/new_${CH}`, `new_${CH}`],
            [`${G}/${CH}/batches/1600000000000.json`, '[]'],
            [`${G}/${CH}/authors/1600000000000.json`, '{}'],
            [`${G}/${CH}/batches/1700000000000.json`, '[]'],
        ]) await ds.put(key, body, { createOnly: true });

        const ingest = jest.fn(async () => {});
        expect((await reconcileArchive(ds, { root, ingest })).fetched).toBe(0);
        expect(ingest).not.toHaveBeenCalled();
        expect(fs.readdirSync(path.join(root, G, `old_${CH}`)).sort()).toEqual(['archive_1600000000000.json', 'authors_1600000000000.json']);
        expect(fs.readdirSync(path.join(root, G, `new_${CH}`))).toEqual(['archive_1700000000000.json']);

        // A record neither folder holds goes in the store's current name.
        await ds.put(`${G}/${CH}/batches/1800000000000.json`, '[]', { createOnly: true });
        expect((await reconcileArchive(ds, { root, ingest })).fetched).toBe(1);
        expect(fs.existsSync(path.join(root, G, `new_${CH}`, 'archive_1800000000000.json'))).toBe(true);
    });
});
