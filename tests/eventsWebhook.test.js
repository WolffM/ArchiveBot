const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../lib/webhookServer');
const { validateEventPayload } = require('../lib/eventWebhook');
const { createMockGuild } = require('./mocks/discord');

const EVENTS_SECRET = 'events-secret-value';
const PICKLEBALL_SECRET = 'test-secret-value';
const GUILD_ID = 'test-guild-events';
const CHANNEL_ID = 'chan-events-1';

function signBody(body, secret = EVENTS_SECRET) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function postWithHandler(handler, path_, bodyObj, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const rawBody = Buffer.from(JSON.stringify(bodyObj));
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: path_,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': rawBody.length,
                        ...extraHeaders,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        let parsed = null;
                        try {
                            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        } catch {
                            // ignore
                        }
                        resolve({ status: res.statusCode, body: parsed });
                    });
                }
            );
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            req.write(rawBody);
            req.end();
        });
    });
}

function validPayload(overrides = {}) {
    const start = new Date(Date.now() + 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 2 * 3600 * 1000);
    return {
        source: 'meet',
        slug: 'testslug1234',
        idempotencyKey: `meet:test-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
        name: 'Board game night',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        description: '3/3 available: a, b, c',
        location: 'https://hadoku.me/meet?e=testslug1234',
        ...overrides,
    };
}

function mockClient(guild) {
    return {
        user: { id: 'bot-user-id' },
        guilds: {
            cache: new Map([[GUILD_ID, guild]]),
            fetch: jest.fn(async (id) => {
                if (id === GUILD_ID) return guild;
                const err = new Error('Unknown Guild');
                err.code = 10004;
                throw err;
            }),
        },
        channels: {
            fetch: jest.fn(async (id) => {
                if (id === CHANNEL_ID) return { id, guildId: GUILD_ID, send: jest.fn() };
                const err = new Error('Unknown Channel');
                err.code = 10003;
                throw err;
            }),
        },
    };
}

function makeHandler(guild) {
    return createHandler({
        discordClient: mockClient(guild),
        channelId: null,
        secret: PICKLEBALL_SECRET,
        eventsSecret: EVENTS_SECRET,
    });
}

const OUTPUT_DIR = path.join(__dirname, '..', 'Output', GUILD_ID);

describe('POST /api/events/create', () => {
    beforeEach(() => {
        process.env.ARCHIVEBOT_EVENT_GUILD_ID = GUILD_ID;
        process.env.ARCHIVEBOT_EVENT_CHANNEL_ID = CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    });

    afterAll(() => {
        delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
        delete process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    });

    test('404 when the events secret is not configured', async () => {
        const handler = createHandler({
            discordClient: mockClient(createMockGuild({ id: GUILD_ID })),
            channelId: 'chan',
            secret: PICKLEBALL_SECRET,
            eventsSecret: null,
        });
        const payload = validPayload();
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(404);
    });

    test('401 without a signature', async () => {
        const handler = makeHandler(createMockGuild({ id: GUILD_ID }));
        const res = await postWithHandler(handler, '/api/events/create', validPayload());
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_signature');
    });

    test('401 with a signature from the wrong (pickleball) secret', async () => {
        const handler = makeHandler(createMockGuild({ id: GUILD_ID }));
        const payload = validPayload();
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload), PICKLEBALL_SECRET),
        });
        expect(res.status).toBe(401);
    });

    test('400 on a stale timestamp', async () => {
        const handler = makeHandler(createMockGuild({ id: GUILD_ID }));
        const payload = validPayload({ timestamp: Date.now() - 30 * 60 * 1000 });
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('stale_timestamp');
    });

    test('400 when the start time is in the past', async () => {
        const handler = makeHandler(createMockGuild({ id: GUILD_ID }));
        const payload = validPayload({
            startTime: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('start_in_past');
    });

    test('creates the event, tracks it in the scheduler store, returns its id', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        const payload = validPayload();
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.eventId).toBeTruthy();
        expect(guild.scheduledEvents.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: payload.name,
                entityMetadata: { location: payload.location },
            })
        );

        const stored = JSON.parse(
            fs.readFileSync(path.join(OUTPUT_DIR, 'scheduled.json'), 'utf8')
        );
        const item = stored.items.find((i) => i.sourceKey === payload.idempotencyKey);
        expect(item).toBeTruthy();
        expect(item.type).toBe('event');
        expect(item.scheduledEventId).toBe(res.body.eventId);
        expect(item.channelId).toBe(CHANNEL_ID);
        expect(item.active).toBe(true);
    });

    test('a replayed idempotency key returns the existing event, creating nothing', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        const payload = validPayload();
        const headers = { 'x-hadoku-signature': signBody(JSON.stringify(payload)) };

        const first = await postWithHandler(handler, '/api/events/create', payload, headers);
        const second = await postWithHandler(handler, '/api/events/create', payload, headers);

        expect(second.status).toBe(200);
        expect(second.body.deduped).toBe(true);
        expect(second.body.eventId).toBe(first.body.eventId);
        expect(guild.scheduledEvents.create).toHaveBeenCalledTimes(1);
    });

    test('500 with a clear error when Discord rejects for permissions', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const err = new Error('Missing Permissions');
        err.code = 50013;
        guild.scheduledEvents.create.mockRejectedValueOnce(err);
        const handler = makeHandler(guild);
        const payload = validPayload();
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('missing_manage_events_permission');
    });

    test('pickleball route still authenticates with its own secret only', async () => {
        const channelSend = jest.fn().mockResolvedValue(undefined);
        const handler = createHandler({
            discordClient: {
                channels: { fetch: jest.fn(async () => ({ send: channelSend })) },
            },
            channelId: 'pb-chan',
            secret: PICKLEBALL_SECRET,
            eventsSecret: EVENTS_SECRET,
        });
        const payload = { kind: 'joined_waitlist', event_title: 'Pickleball' };
        const res = await postWithHandler(handler, '/api/pickleball/waitlist-outcome', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload), PICKLEBALL_SECRET),
        });
        expect(res.status).toBe(200);
        expect(channelSend).toHaveBeenCalled();
    });
});

describe('validateEventPayload', () => {
    test('rejects a missing idempotency key', () => {
        const result = validateEventPayload(validPayload({ idempotencyKey: undefined }));
        expect(result.ok).toBe(false);
        expect(result.error).toBe('missing_idempotency_key');
    });

    test('rejects end before start', () => {
        const start = new Date(Date.now() + 3600 * 1000);
        const result = validateEventPayload(
            validPayload({
                startTime: start.toISOString(),
                endTime: new Date(start.getTime() - 1000).toISOString(),
            })
        );
        expect(result.ok).toBe(false);
        expect(result.error).toBe('end_not_after_start');
    });

    test('falls back to the name as location when none is given', () => {
        const result = validateEventPayload(validPayload({ location: undefined }));
        expect(result.ok).toBe(true);
        expect(result.value.location).toBe('Board game night');
    });
});
