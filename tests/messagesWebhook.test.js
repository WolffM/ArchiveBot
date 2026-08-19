// Stubbed so the failure mirror is observable without a monitoring-api. The
// point of the alert namespace is that an accepted-then-undelivered message
// leaves a trace somewhere other than a 500 nobody reads.
jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../lib/webhookServer');
const { mirrorToLedger, mirrorFailureToLedger } = require('../lib/ledger');
const { validateMessagePayload, MAX_CONTENT_LENGTH } = require('../lib/messageWebhook');

const EVENTS_SECRET = 'events-secret-value';
const PICKLEBALL_SECRET = 'test-secret-value';
const GUILD_ID = 'test-guild-messages';
const CHANNEL_ID = 'chan-messages-1';
const OTHER_GUILD_CHANNEL_ID = 'chan-elsewhere-1';

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
    return {
        source: 'meet',
        slug: 'testslug1234',
        idempotencyKey: `meet-poll:test-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
        content: '**Dinner** — the votes are in.\nWinner: **Pizza** (5 of 9 ballots).',
        ...overrides,
    };
}

/** Client whose send() records its arguments, so mention handling is testable. */
function mockClient() {
    const send = jest.fn(async () => ({ id: 'sent-message-id' }));
    return {
        send,
        client: {
            user: { id: 'bot-user-id' },
            channels: {
                fetch: jest.fn(async (id) => {
                    if (id === CHANNEL_ID) return { id, guildId: GUILD_ID, send };
                    if (id === OTHER_GUILD_CHANNEL_ID) {
                        return { id, guildId: 'some-other-guild', send };
                    }
                    const err = new Error('Unknown Channel');
                    err.code = 10003;
                    throw err;
                }),
            },
        },
    };
}

function makeHandler(discordClient, { eventsSecret = EVENTS_SECRET } = {}) {
    return createHandler({
        discordClient,
        channelId: null,
        secret: PICKLEBALL_SECRET,
        eventsSecret,
    });
}

function post(handler, payload, secret = EVENTS_SECRET) {
    return postWithHandler(handler, '/api/messages/send', payload, {
        'x-hadoku-signature': signBody(JSON.stringify(payload), secret),
    });
}

const OUTPUT_DIR = path.join(__dirname, '..', 'Output', GUILD_ID);

describe('validateMessagePayload', () => {
    test('rejects a missing, empty or oversized body', () => {
        expect(validateMessagePayload({}).error).toBe('invalid_content');
        expect(validateMessagePayload(validPayload({ content: '   ' })).error).toBe(
            'invalid_content'
        );
        expect(
            validateMessagePayload(validPayload({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }))
                .error
        ).toBe('invalid_content');
    });

    test('requires an idempotency key', () => {
        expect(validateMessagePayload(validPayload({ idempotencyKey: '' })).error).toBe(
            'missing_idempotency_key'
        );
    });

    test('rejects a stale or missing timestamp', () => {
        expect(validateMessagePayload(validPayload({ timestamp: undefined })).error).toBe(
            'stale_timestamp'
        );
        expect(
            validateMessagePayload(validPayload({ timestamp: Date.now() - 11 * 60 * 1000 })).error
        ).toBe('stale_timestamp');
    });

    test('accepts a well-formed payload', () => {
        const result = validateMessagePayload(validPayload());
        expect(result.ok).toBe(true);
        expect(result.value.idempotencyKey).toMatch(/^meet-poll:/);
    });
});

describe('POST /api/messages/send', () => {
    beforeEach(() => {
        process.env.ARCHIVEBOT_EVENT_GUILD_ID = GUILD_ID;
        process.env.ARCHIVEBOT_EVENT_CHANNEL_ID = CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
        mirrorToLedger.mockClear();
        mirrorFailureToLedger.mockClear();
    });

    describe('telemetry', () => {
        it('mirrors a delivered message as activity, and raises no alert', async () => {
            const { client } = mockClient();
            const res = await post(makeHandler(client), validPayload());

            expect(res.status).toBe(200);
            expect(mirrorToLedger).toHaveBeenCalledWith(
                'archivebot.message',
                'message posted',
                expect.objectContaining({ source: 'meet', channelId: CHANNEL_ID })
            );
            expect(mirrorFailureToLedger).not.toHaveBeenCalled();
        });

        it.each([
            ['missing_send_permission', Object.assign(new Error('Missing Permissions'), { code: 50013 })],
            ['discord_rate_limited', Object.assign(new Error('Too Many Requests'), { status: 429 })],
            ['message_send_failed', new Error('gateway exploded')],
        ])('raises one alert when the send fails with %s', async (reason, err) => {
            const { client, send } = mockClient();
            send.mockRejectedValueOnce(err);

            const res = await post(makeHandler(client), validPayload());

            expect(res.body.success).toBe(false);
            // Accepted, then undelivered — the caller sees a 5xx it may not act
            // on, so the ledger carries the record. Exactly one alert per
            // failure, whichever Discord code caused it.
            expect(mirrorFailureToLedger).toHaveBeenCalledTimes(1);
            expect(mirrorFailureToLedger).toHaveBeenCalledWith(
                'archivebot.message',
                'message not delivered',
                expect.objectContaining({ source: 'meet', channelId: CHANNEL_ID, reason, error: err })
            );
            expect(mirrorToLedger).not.toHaveBeenCalled();
        });

        it('stays silent for a request refused before any send was attempted', async () => {
            const { client } = mockClient();
            // Bad signature: the caller's bug, already answered with a 401.
            // Alerting on it would drown the failures that matter.
            const payload = validPayload();
            const res = await postWithHandler(makeHandler(client), '/api/messages/send', payload, {
                'x-hadoku-signature': signBody(JSON.stringify(payload), 'wrong-secret'),
            });

            expect(res.status).toBe(401);
            expect(mirrorFailureToLedger).not.toHaveBeenCalled();
        });
    });

    afterAll(() => {
        delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
        delete process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    });

    test('404 when the events secret is not configured', async () => {
        const { client } = mockClient();
        const res = await post(makeHandler(client, { eventsSecret: null }), validPayload());
        expect(res.status).toBe(404);
    });

    test('401 without a signature', async () => {
        const { client } = mockClient();
        const res = await postWithHandler(
            makeHandler(client),
            '/api/messages/send',
            validPayload()
        );
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_signature');
    });

    test('401 with a signature from the wrong secret', async () => {
        const { client } = mockClient();
        const res = await post(makeHandler(client), validPayload(), PICKLEBALL_SECRET);
        expect(res.status).toBe(401);
    });

    test('404 on GET — the route table is POST-only', async () => {
        const { client } = mockClient();
        const handler = makeHandler(client);
        const res = await new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                http.get(
                    { host: '127.0.0.1', port, path: '/api/messages/send' },
                    (r) => {
                        r.resume();
                        r.on('end', () => {
                            server.close();
                            resolve({ status: r.statusCode });
                        });
                    }
                ).on('error', (e) => {
                    server.close();
                    reject(e);
                });
            });
        });
        expect(res.status).toBe(404);
    });

    test('posts the message and returns its id', async () => {
        const { client, send } = mockClient();
        const res = await post(makeHandler(client), validPayload());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, messageId: 'sent-message-id' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('suppresses every mention in the posted content', async () => {
        // The text is built from a poll title and option labels that a user
        // typed, so an @everyone in either must not ping the guild.
        const { client, send } = mockClient();
        const res = await post(
            makeHandler(client),
            validPayload({ content: '@everyone the winner is <@&1234>' })
        );
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ allowedMentions: { parse: [] } })
        );
    });

    test('a repeated idempotency key does not post twice', async () => {
        const { client, send } = mockClient();
        const handler = makeHandler(client);
        const payload = validPayload();

        const first = await post(handler, payload);
        expect(first.status).toBe(200);
        expect(first.body.deduped).toBeUndefined();

        const second = await post(handler, { ...payload, timestamp: Date.now() });
        expect(second.status).toBe(200);
        expect(second.body).toEqual({
            success: true,
            messageId: 'sent-message-id',
            deduped: true,
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('a different idempotency key posts again', async () => {
        const { client, send } = mockClient();
        const handler = makeHandler(client);
        await post(handler, validPayload());
        await post(handler, validPayload());
        expect(send).toHaveBeenCalledTimes(2);
    });

    test('refuses a channel outside the configured guild', async () => {
        const { client, send } = mockClient();
        const res = await post(
            makeHandler(client),
            validPayload({ channel_id: OTHER_GUILD_CHANNEL_ID })
        );
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('channel_not_in_guild');
        expect(send).not.toHaveBeenCalled();
    });

    test('reports an unknown channel rather than throwing', async () => {
        const { client } = mockClient();
        const res = await post(makeHandler(client), validPayload({ channel_id: 'nope' }));
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('channel_not_found');
    });

    test('400 on a malformed payload', async () => {
        const { client, send } = mockClient();
        const res = await post(makeHandler(client), validPayload({ content: '' }));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_content');
        expect(send).not.toHaveBeenCalled();
    });
});
