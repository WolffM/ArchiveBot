const crypto = require('crypto');
const http = require('http');
const {
    createHandler,
    formatWaitlistMessage,
    verifySignature,
} = require('../lib/webhookServer');

const SECRET = 'test-secret-value';

function signBody(body, secret = SECRET) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function postWithHandler(handler, path, bodyObj, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const rawBody = Buffer.from(JSON.stringify(bodyObj));
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
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

describe('verifySignature', () => {
    test('accepts correct signature', () => {
        const body = Buffer.from('{"kind":"joined_waitlist"}');
        const sig = signBody(body);
        expect(verifySignature(body, sig, SECRET)).toBe(true);
    });

    test('rejects wrong secret', () => {
        const body = Buffer.from('{"kind":"joined_waitlist"}');
        const sig = signBody(body, 'other-secret');
        expect(verifySignature(body, sig, SECRET)).toBe(false);
    });

    test('rejects tampered body', () => {
        const body = Buffer.from('{"kind":"joined_waitlist"}');
        const sig = signBody(body);
        const tampered = Buffer.from('{"kind":"something_else"}');
        expect(verifySignature(tampered, sig, SECRET)).toBe(false);
    });

    test('rejects missing signature', () => {
        const body = Buffer.from('{}');
        expect(verifySignature(body, null, SECRET)).toBe(false);
    });

    test('rejects missing secret', () => {
        const body = Buffer.from('{}');
        const sig = signBody(body);
        expect(verifySignature(body, sig, null)).toBe(false);
    });
});

describe('formatWaitlistMessage', () => {
    test('joined_waitlist includes title and url', () => {
        const msg = formatWaitlistMessage({
            kind: 'joined_waitlist',
            event_title: 'Open Play - Advanced',
            event_url: 'https://example.com/events/abc',
            matched_time: '7:00pm - 9:00pm',
        });
        expect(msg).toMatch(/Joined waitlist.*Open Play - Advanced/);
        expect(msg).toMatch(/7:00pm - 9:00pm/);
        expect(msg).toMatch(/example\.com\/events\/abc/);
    });

    test('trigger_signed_up mentions signup', () => {
        const msg = formatWaitlistMessage({
            kind: 'trigger_signed_up',
            event_title: 'Open Play - Advanced',
            signup_url: 'https://example.com/events/abc/signup',
        });
        expect(msg).toMatch(/Signed up from waitlist.*Open Play - Advanced/);
        expect(msg).toMatch(/\/signup/);
    });

    test('trigger_sold_out mentions still sold out', () => {
        const msg = formatWaitlistMessage({
            kind: 'trigger_sold_out',
            event_title: 'Open Play - Advanced',
            event_url: 'https://example.com/events/abc',
        });
        expect(msg).toMatch(/still sold out.*Open Play - Advanced/);
        expect(msg).toMatch(/Staying on the waitlist/);
    });

    test('trigger_failed includes error', () => {
        const msg = formatWaitlistMessage({
            kind: 'trigger_failed',
            event_title: 'Open Play - Advanced',
            error: 'network_timeout',
        });
        expect(msg).toMatch(/Waitlist trigger failed/);
        expect(msg).toMatch(/network_timeout/);
    });

    test('unknown kind falls back to generic format', () => {
        const msg = formatWaitlistMessage({
            kind: 'something_weird',
            event_title: 'Open Play - Advanced',
        });
        expect(msg).toMatch(/Pickleball update.*Open Play - Advanced/);
    });
});

describe('createHandler', () => {
    function mockDiscordClient(channelSend) {
        return {
            channels: {
                fetch: jest.fn(async () => ({ send: channelSend })),
            },
        };
    }

    test('404 for wrong path', async () => {
        const handler = createHandler({
            discordClient: mockDiscordClient(jest.fn()),
            channelId: 'channel-1',
            secret: SECRET,
        });
        const { status, body } = await postWithHandler(handler, '/wrong', {});
        expect(status).toBe(404);
        expect(body.error).toBe('not_found');
    });

    test('401 without signature', async () => {
        const handler = createHandler({
            discordClient: mockDiscordClient(jest.fn()),
            channelId: 'channel-1',
            secret: SECRET,
        });
        const { status, body } = await postWithHandler(
            handler,
            '/api/pickleball/waitlist-outcome',
            { kind: 'joined_waitlist' }
        );
        expect(status).toBe(401);
        expect(body.error).toBe('invalid_signature');
    });

    test('401 with wrong signature', async () => {
        const handler = createHandler({
            discordClient: mockDiscordClient(jest.fn()),
            channelId: 'channel-1',
            secret: SECRET,
        });
        const { status } = await postWithHandler(
            handler,
            '/api/pickleball/waitlist-outcome',
            { kind: 'joined_waitlist' },
            { 'x-hadoku-signature': 'sha256=deadbeef' }
        );
        expect(status).toBe(401);
    });

    test('200 and posts to discord on valid signature', async () => {
        const send = jest.fn(async () => ({ id: 'msg-1' }));
        const discordClient = mockDiscordClient(send);
        const handler = createHandler({
            discordClient,
            channelId: 'channel-1',
            secret: SECRET,
        });

        const payload = {
            kind: 'joined_waitlist',
            event_title: 'Open Play - Advanced',
            event_url: 'https://example.com/events/abc',
        };
        const rawBody = Buffer.from(JSON.stringify(payload));
        const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');

        const { status, body } = await postWithHandler(
            handler,
            '/api/pickleball/waitlist-outcome',
            payload,
            { 'x-hadoku-signature': sig }
        );
        expect(status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(discordClient.channels.fetch).toHaveBeenCalledWith('channel-1');
        expect(send).toHaveBeenCalledTimes(1);
        const sent = send.mock.calls[0][0];
        expect(sent.content).toMatch(/Joined waitlist.*Open Play - Advanced/);
    });

    test('500 when channel fetch fails', async () => {
        const discordClient = {
            channels: {
                fetch: jest.fn(async () => {
                    throw new Error('unknown channel');
                }),
            },
        };
        const handler = createHandler({
            discordClient,
            channelId: 'channel-1',
            secret: SECRET,
        });

        const payload = { kind: 'joined_waitlist', event_title: 't' };
        const rawBody = Buffer.from(JSON.stringify(payload));
        const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');

        const { status, body } = await postWithHandler(
            handler,
            '/api/pickleball/waitlist-outcome',
            payload,
            { 'x-hadoku-signature': sig }
        );
        expect(status).toBe(500);
        expect(body.error).toBe('discord_post_failed');
    });
});
