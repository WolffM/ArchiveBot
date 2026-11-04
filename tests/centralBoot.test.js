/**
 * index.js in central mode, wired end to end against dataplatform's REAL
 * listener: the Discord client is a fake whose login is a spy, so this proves
 * the bot never logs in without the lease, that /health follows it, and that
 * losing it destroys the client and exits 75. process.exit is stubbed.
 */
const { EventEmitter } = require('events');
const http = require('http');
const net = require('net');
const { DataStore } = require('../lib/dataStore');
const { startDataListener, KEY } = require('./support/dataListener');

class MockClient extends EventEmitter {
    constructor() {
        super();
        MockClient.last = this;
        this.login = jest.fn(async () => 'token');
        this.destroy = jest.fn();
        this.ready = false;
        this.guilds = { cache: new Map() };
        this.application = { commands: { set: jest.fn(async () => {}) } };
        this.rest = {};
    }
    isReady() {
        return this.ready;
    }
}
jest.mock('discord.js', () => ({ ...jest.requireActual('discord.js'), Client: MockClient }));

const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});
const health = (port) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject);
});
const until = async (cond, ms) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 50));
    }
};

let listener;
let other;
let exit;
const saved = {};
beforeAll(async () => {
    listener = await startDataListener();
    other = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
}, 20000);
afterAll(() => {
    other.close();
    listener.stop();
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGUSR2']) process.removeAllListeners(sig);
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

test('waits as a standby without logging in, takes over when the lease frees, and exits 75 when it is lost', async () => {
    const port = await freePort();
    const env = {
        ARCHIVEBOT_STATE_STORE: 'central',
        HADOKU_DATA_URL: listener.url,
        HADOKU_SERVICE_KEY: KEY,
        WEBHOOK_PORT: String(port),
        DISCORD_TOKEN: 'fake',
    };
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});

    // Another node holds the lease.
    const theirs = await other.acquireLease('state/', { ttl: 30, holder: 'other-node' });
    jest.isolateModules(() => { require('../index'); });
    const client = MockClient.last;

    await until(async () => (await health(port).catch(() => null))?.status === 503, 3000);
    await new Promise((r) => setTimeout(r, 300));
    expect(client.login).not.toHaveBeenCalled();
    expect(await health(port)).toEqual({ status: 503, body: { detail: { central: expect.objectContaining({ state: 'standby' }) } } });

    // It frees: the standby takes the lease (polled every 5 s), reconciles, and only then logs in.
    await other.releaseLease('state/', theirs.token);
    await until(() => client.login.mock.calls.length > 0, 8000);
    expect((await other.leaseInfo('state/')).held).toBe(true);
    expect((await health(port)).body.detail.central.state).toBe('starting');

    client.ready = true;
    client.emit('clientReady');
    await until(async () => (await health(port)).status === 200, 3000);
    expect((await health(port)).body).toMatchObject({ status: 'ok', discord: 'ready', central: { state: 'active' } });

    // The lease is taken from under it: the client is destroyed and the process exits 75.
    const lease = await other.leaseInfo('state/');
    expect(lease.held).toBe(true);
    const token = Number(lease.token);
    await other.releaseLease('state/', token);
    await until(() => exit.mock.calls.length > 0, 15000);
    expect(exit).toHaveBeenCalledWith(75);
    expect(client.destroy).toHaveBeenCalled();
    require('../lib/scheduler').stopScheduler();
}, 40000);
