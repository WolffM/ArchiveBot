const crypto = require('crypto');
const http = require('http');
const {
    createHandler,
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

// The auth flow every signed route shares, driven through /api/messages/send
// (its handler's own behaviour is messagesWebhook.test.js's).
describe('createHandler', () => {
    const handler = () =>
        createHandler({ discordClient: { channels: { fetch: jest.fn() } }, eventsSecret: SECRET });

    test('404 for wrong path', async () => {
        const { status, body } = await postWithHandler(handler(), '/wrong', {});
        expect(status).toBe(404);
        expect(body.error).toBe('not_found');
    });

    test('404 for a route none of whose callers has a secret set', async () => {
        const unconfigured = createHandler({ discordClient: {} });
        const payload = { text: 'x' };
        const { status } = await postWithHandler(unconfigured, '/api/messages/send', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(status).toBe(404);
    });

    test('401 without signature', async () => {
        const { status, body } = await postWithHandler(handler(), '/api/messages/send', { text: 'x' });
        expect(status).toBe(401);
        expect(body.error).toBe('invalid_signature');
    });

    test('401 with wrong signature', async () => {
        const { status } = await postWithHandler(
            handler(),
            '/api/messages/send',
            { text: 'x' },
            { 'x-hadoku-signature': 'sha256=deadbeef' }
        );
        expect(status).toBe(401);
    });
});

describe('GET /health', () => {
    function get(handler, path) {
        return new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.listen(0, '127.0.0.1', () => {
                http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
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
    const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    test('answers the checkout commit, unauthenticated, while Discord is ready', async () => {
        const handler = createHandler({ discordClient: { isReady: () => true } });
        await expect(get(handler, '/health')).resolves.toEqual({ status: 200, body: { status: 'ok', commit: head, discord: 'ready' } });
    });

    test('is 503 while the Discord session is down', async () => {
        const handler = createHandler({ discordClient: { isReady: () => false } });
        await expect(get(handler, '/health')).resolves.toEqual({ status: 503, body: { status: 'not_ready', commit: head, discord: 'not_ready' } });
    });

    test('is only a GET', async () => {
        const handler = createHandler({ discordClient: { isReady: () => true } });
        const { status } = await postWithHandler(handler, '/health', {});
        expect(status).toBe(404);
    });
});
