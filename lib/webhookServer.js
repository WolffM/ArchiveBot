/**
 * Lightweight HTTP webhook server for ArchiveBot.
 *
 * Exposes POST /api/pickleball/waitlist-outcome so hadoku-scrape can notify
 * Discord when a waitlist row is joined or a trigger fires. All other
 * paths return 404.
 *
 * Auth: HMAC-SHA256 over the raw request body, sent as
 *   X-Hadoku-Signature: sha256=<hex>
 * using the shared secret in env PICKLEBALL_WEBHOOK_SECRET. Constant-time
 * comparison. Replays are allowed — Discord dedupes visually and idempotency
 * is not worth the complexity at this scope.
 */

const crypto = require('crypto');
const http = require('http');
const { createLogger } = require('../utils/logger');

const log = createLogger('webhook');

const DEFAULT_PORT = 3004;

function verifySignature(rawBody, headerValue, secret) {
    if (!secret || !headerValue) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(headerValue);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function formatWaitlistMessage(payload) {
    const title = payload.event_title || 'Unknown event';
    const url = payload.event_url || '';
    const signupUrl = payload.signup_url || '';
    const matchedTime = payload.matched_time;
    const spotsLeft = payload.spots_left;
    const err = payload.error;

    const lines = [];

    switch (payload.kind) {
        case 'joined_waitlist':
            lines.push(`**Joined waitlist:** ${title}`);
            if (matchedTime) lines.push(`Time: ${matchedTime}`);
            if (url) lines.push(url);
            lines.push(
                "You'll get pinged in this channel when a spot opens and " +
                'the auto-signup runs.'
            );
            break;

        case 'trigger_signed_up':
            lines.push(`**Signed up from waitlist:** ${title}`);
            if (matchedTime) lines.push(`Time: ${matchedTime}`);
            if (signupUrl) lines.push(signupUrl);
            break;

        case 'signed_up_direct':
            lines.push(`**Signed up:** ${title}`);
            if (matchedTime) lines.push(`Time: ${matchedTime}`);
            if (url) lines.push(url);
            break;

        case 'trigger_already_signed_up':
        case 'already_signed_up_direct':
            lines.push(`**Already signed up:** ${title}`);
            if (matchedTime) lines.push(`Time: ${matchedTime}`);
            if (url) lines.push(url);
            break;

        case 'trigger_sold_out':
            lines.push(`**Waitlist trigger fired — still sold out:** ${title}`);
            if (spotsLeft != null) lines.push(`Spots left: ${spotsLeft}`);
            if (url) lines.push(url);
            lines.push('Staying on the waitlist for the next trigger.');
            break;

        case 'trigger_failed':
            lines.push(`**Waitlist trigger failed:** ${title}`);
            if (err) lines.push(`Error: ${err}`);
            if (url) lines.push(url);
            break;

        case 'signup_failed_direct':
            lines.push(`**Signup failed:** ${title}`);
            if (err) lines.push(`Error: ${err}`);
            if (url) lines.push(url);
            break;

        default:
            lines.push(`**Pickleball update:** ${title}`);
            if (err) lines.push(`Error: ${err}`);
            if (url) lines.push(url);
    }

    return lines.join('\n');
}

function readJsonBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error('payload_too_large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

/**
 * Build the HTTP handler. Factored out so tests can exercise it without
 * binding to a port.
 *
 * @param {object} opts
 * @param {import('discord.js').Client} opts.discordClient
 * @param {string} opts.channelId
 * @param {string} opts.secret
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
function createHandler({ discordClient, channelId, secret }) {
    return async function handler(req, res) {
        if (req.method !== 'POST' || req.url !== '/api/pickleball/waitlist-outcome') {
            sendJson(res, 404, { success: false, error: 'not_found' });
            return;
        }

        let rawBody;
        try {
            rawBody = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 413, { success: false, error: err.message });
            return;
        }

        const sig = req.headers['x-hadoku-signature'];
        if (!verifySignature(rawBody, sig, secret)) {
            log.warn('invalid_signature', {
                hasSecret: !!secret,
                hasHeader: !!sig,
            });
            sendJson(res, 401, { success: false, error: 'invalid_signature' });
            return;
        }

        let payload;
        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch (err) {
            sendJson(res, 400, { success: false, error: 'invalid_json' });
            return;
        }

        if (!channelId) {
            log.error('missing_channel_id', null, { kind: payload.kind });
            sendJson(res, 500, { success: false, error: 'channel_not_configured' });
            return;
        }

        try {
            const channel = await discordClient.channels.fetch(channelId);
            if (!channel || typeof channel.send !== 'function') {
                throw new Error(`channel_not_sendable:${channelId}`);
            }
            const content = formatWaitlistMessage(payload);
            await channel.send({ content });
            log.info('waitlist_outcome_posted', {
                kind: payload.kind,
                event_title: payload.event_title,
            });
            sendJson(res, 200, { success: true });
        } catch (err) {
            log.error('waitlist_outcome_post_failed', err, {
                kind: payload.kind,
                channelId,
            });
            sendJson(res, 500, { success: false, error: 'discord_post_failed' });
        }
    };
}

/**
 * Start the webhook server. Returns the http.Server instance (for tests /
 * graceful shutdown). Logs a clear message if the secret / channel aren't
 * configured and refuses to start in that case.
 */
function startWebhookServer({ discordClient, port = DEFAULT_PORT } = {}) {
    const secret = process.env.PICKLEBALL_WEBHOOK_SECRET;
    const channelId = process.env.PICKLEBALL_CHANNEL_ID;

    if (!secret) {
        log.warn('webhook_disabled', {
            reason: 'PICKLEBALL_WEBHOOK_SECRET not set — webhook server will NOT start',
        });
        return null;
    }
    if (!channelId) {
        log.warn('webhook_disabled', {
            reason: 'PICKLEBALL_CHANNEL_ID not set — webhook server will NOT start',
        });
        return null;
    }

    const handler = createHandler({ discordClient, channelId, secret });
    const server = http.createServer(handler);

    const boundPort = Number(process.env.WEBHOOK_PORT) || port;
    server.listen(boundPort, '127.0.0.1', () => {
        log.success('webhook_listening', { port: boundPort });
    });
    server.on('error', err => {
        log.error('webhook_server_error', err, { port: boundPort });
    });

    return server;
}

module.exports = {
    startWebhookServer,
    createHandler,
    formatWaitlistMessage,
    verifySignature,
};
