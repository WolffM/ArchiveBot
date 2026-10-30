// /api/discord/* — Discord identity for hadoku avatars, prefs-api's secret only.
// Discord's HTTP API is a stubbed global fetch; the bot's user lookup is a
// stubbed discordClient.users.fetch. Both are the boundary this module owns.
jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const crypto = require('crypto');
const http = require('http');
const { createHandler } = require('../lib/webhookServer');
const { avatarUrl, REDIRECT_URI } = require('../lib/discordIdentity');

const PREFS_SECRET = 'prefs-secret-value';
const EVENTS_SECRET = 'events-secret-value';
const HASH = '8342729096ea3675442027381ff50dfe';
const USER_ID = '80351110224678912';
const STATE = 'a'.repeat(64);

function sign(body, secret = PREFS_SECRET) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function post(handler, path, bodyObj, secret = PREFS_SECRET) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const raw = Buffer.from(JSON.stringify(bodyObj));
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: server.address().port,
                    path,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': raw.length,
                        'x-hadoku-signature': sign(raw, secret),
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                    });
                }
            );
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            req.end(raw);
        });
    });
}

function makeHandler(users = {}) {
    const discordClient = {
        isReady: () => true,
        users: {
            fetch: jest.fn(async (id) => {
                if (!(id in users)) throw Object.assign(new Error('Unknown User'), { code: 10013 });
                return { id, avatar: users[id] };
            }),
        },
    };
    const handler = createHandler({
        discordClient,
        prefsSecret: PREFS_SECRET,
        eventsSecret: EVENTS_SECRET,
        commit: 'test',
    });
    return { handler, discordClient };
}

const realFetch = global.fetch;
beforeEach(() => {
    process.env.CLIENT_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'client-secret';
});
afterEach(() => {
    global.fetch = realFetch;
    delete process.env.CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
});

describe('caller scoping', () => {
    test("refuses the events caller's signature", async () => {
        const { handler } = makeHandler();
        const res = await post(handler, '/api/discord/users', { ids: [USER_ID] }, EVENTS_SECRET);
        expect(res.status).toBe(401);
    });

    test('is absent when the prefs secret is unset', async () => {
        const handler = createHandler({ discordClient: { isReady: () => true }, eventsSecret: EVENTS_SECRET, commit: 't' });
        const res = await post(handler, '/api/discord/users', { ids: [USER_ID] });
        expect(res.status).toBe(404);
    });
});

describe('/api/discord/oauth/authorize-url', () => {
    test('builds an identify-only code-flow URL to the hadoku callback', async () => {
        const { handler } = makeHandler();
        const res = await post(handler, '/api/discord/oauth/authorize-url', { state: STATE });
        expect(res.status).toBe(200);
        const url = new URL(res.body.url);
        expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
        expect(url.searchParams.get('scope')).toBe('identify');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
        expect(url.searchParams.get('client_id')).toBe('123456789012345678');
        expect(url.searchParams.get('state')).toBe(STATE);
    });

    test('refuses a malformed state', async () => {
        const { handler } = makeHandler();
        expect((await post(handler, '/api/discord/oauth/authorize-url', { state: 'x&redirect_uri=evil' })).status).toBe(400);
    });

    test('answers 503 without the client secret', async () => {
        delete process.env.DISCORD_CLIENT_SECRET;
        const { handler } = makeHandler();
        expect((await post(handler, '/api/discord/oauth/authorize-url', { state: STATE })).status).toBe(503);
    });
});

describe('/api/discord/oauth/exchange', () => {
    test('exchanges, reads the user, revokes, returns id + avatar', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, init = {}) => {
            calls.push(url);
            if (url.endsWith('/oauth2/token')) {
                expect(init.headers.Authorization).toBe(
                    'Basic ' + Buffer.from('123456789012345678:client-secret').toString('base64')
                );
                expect(init.body.get('redirect_uri')).toBe(REDIRECT_URI);
                return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
            }
            if (url.endsWith('/users/@me')) return new Response(JSON.stringify({ id: USER_ID, avatar: HASH }), { status: 200 });
            if (url.endsWith('/oauth2/token/revoke')) return new Response(null, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });
        const { handler } = makeHandler();
        const res = await post(handler, '/api/discord/oauth/exchange', { code: 'abc' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, id: USER_ID, avatar_url: avatarUrl(USER_ID, HASH) });
        expect(calls.some((u) => u.endsWith('/oauth2/token/revoke'))).toBe(true);
    });

    test('revokes even when /users/@me fails', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url) => {
            calls.push(url);
            if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
            if (url.endsWith('/users/@me')) return new Response('{}', { status: 500 });
            return new Response(null, { status: 200 });
        });
        const { handler } = makeHandler();
        expect((await post(handler, '/api/discord/oauth/exchange', { code: 'abc' })).status).toBe(502);
        expect(calls.some((u) => u.endsWith('/oauth2/token/revoke'))).toBe(true);
    });

    test('a rejected code is the user\'s 400', async () => {
        global.fetch = jest.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
        const { handler } = makeHandler();
        const res = await post(handler, '/api/discord/oauth/exchange', { code: 'used' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('code_rejected');
    });
});

describe('/api/discord/users', () => {
    test('current avatars by id; null without one; unknown users absent', async () => {
        const { handler, discordClient } = makeHandler({ [USER_ID]: HASH, '111111111111111111': null });
        const res = await post(handler, '/api/discord/users', { ids: [USER_ID, '111111111111111111', '222222222222222222'] });
        expect(res.status).toBe(200);
        expect(res.body.users).toEqual({ [USER_ID]: avatarUrl(USER_ID, HASH), '111111111111111111': null });
        expect(discordClient.users.fetch).toHaveBeenCalledWith(USER_ID, { force: true });
    });

    test('refuses non-snowflakes and more than 100 ids', async () => {
        const { handler } = makeHandler();
        expect((await post(handler, '/api/discord/users', { ids: ['../x'] })).status).toBe(400);
        const many = Array.from({ length: 101 }, (_, i) => String(10 ** 17 + i));
        expect((await post(handler, '/api/discord/users', { ids: many })).status).toBe(400);
    });
});

describe('avatarUrl', () => {
    test('null for no avatar or a malformed hash; static png for animated', () => {
        expect(avatarUrl(USER_ID, null)).toBeNull();
        expect(avatarUrl(USER_ID, '../x')).toBeNull();
        expect(avatarUrl(USER_ID, `a_${HASH}`)).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/a_${HASH}.png?size=256`);
    });
});
