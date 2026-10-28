/**
 * Lightweight HTTP webhook server for ArchiveBot.
 *
 * Routes (all HMAC-authenticated, everything else 404):
 *   /api/pickleball/waitlist-outcome — hadoku-scrape notifies Discord about
 *       waitlist joins/triggers. Secret: PICKLEBALL_WEBHOOK_SECRET. Replays
 *       are allowed — Discord dedupes visually.
 *   /api/events/create — external services (rally-api) create a Discord guild
 *       scheduled event. Secret: ARCHIVEBOT_EVENTS_WEBHOOK_SECRET. Replay-
 *       guarded by a signed timestamp + idempotency key (see eventWebhook.js)
 *       because a replayed POST here would create a duplicate event.
 *   /api/events/update — moves or cancels an event /create already made, by the
 *       scheduledEventId the caller kept. Same secret as /create. Exists for
 *       rally-api's reopen: a closed event can be reopened and closed again on a
 *       different time, and without an edit path that means either a duplicate
 *       guild event or a stale one. Same replay guard, plus a per-item record
 *       of the last applied key so a retried update is a no-op.
 *   /api/events/channels — lists the caller's guild's postable text channels
 *       so a caller can render a channel picker. Same secret as /create. POST
 *       despite being a read: the HMAC signs the request body, and a GET has no
 *       body to sign.
 *   /api/spaces/provision — creates a private meeting space (category + chat +
 *       Meeting Room + role + single-use invite). Secret:
 *       ARCHIVEBOT_SPACES_WEBHOOK_SECRET — its OWN, not the events one: a
 *       caller that can carve out private channels and kick members should not
 *       thereby be able to create guild events. Replay-guarded by signed
 *       timestamp + idempotency key; a replay would burn 3 channels of a
 *       500-channel budget.
 *   /api/spaces/revoke — early teardown of a space by spaceId, for a cancelled
 *       booking. Same secret. Idempotent: revoking an already-dead space is a
 *       success, not a 404.
 *   /api/spaces/sweep — deletes every EXPIRED space and kicks its guest. Same
 *       secret. Driven by the fleet cron rather than an in-process timer: a
 *       timer dies silently on a restart and is discovered at the channel
 *       ceiling, whereas a cron job that stops reporting is a failed
 *       JobExecution that pages. Answers 500 if any teardown failed, for the
 *       same reason.
 *   /api/messages/send — posts one plain message to a channel. Same secret as
 *       /api/events/*. For announcements that are not events: rally-api's
 *       ranked-choice polls end with a winner that has no start time, which
 *       /api/events/create cannot represent. Replay-guarded the same way as
 *       /create (see messageWebhook.js).
 *   GET /api/messages/recent?channel=general&limit=5 — the last few messages
 *       in the cardtable guild's #general as plain text, for hadoku-cardtable's
 *       front page (see recentMessages.js). cardtable's secret only. The one
 *       GET: it signs the query string, there being no body. Not replay-
 *       guarded — a replay reads what the caller could already read.
 *
 * And one GET, unauthenticated: /health answers `{status, commit, discord}`,
 * 200 while the Discord session is ready and 503 while it is not. `commit` is
 * the checkout's HEAD, read once at start: hadoku_site's deploy and its
 * service move (scripts/admin/service-move.mjs) check it against the commit
 * they deployed. It names nothing a caller could use.
 *
 * Auth: HMAC-SHA256 over the raw request body (a GET's raw query string,
 * without the `?`), sent as
 *   X-Hadoku-Signature: sha256=<hex>
 * with a shared secret per CALLER. Constant-time comparison.
 *
 * A route may accept more than one caller, each with its own secret, and the
 * secret that verifies is what identifies the caller. /api/events/* and
 * /api/messages/send accept two:
 *   events     ARCHIVEBOT_EVENTS_WEBHOOK_SECRET — rally-api. Any guild the
 *              payload names, ARCHIVEBOT_EVENT_GUILD_ID by default. Plain
 *              messages only.
 *   cardtable  ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET — hadoku-cardtable. Scoped
 *              to the guild `/setup cardtable` bound (lib/cardtableStore.js):
 *              a guild_id naming any other guild is refused 403, a missing
 *              channel_id defaults to #announcements (messages) or #events
 *              (event announcements), and messages may carry embeds.
 * The two are separate so that neither caller's leaked secret is worth the
 * other's capabilities — meet's cannot post embeds, cardtable's cannot reach
 * meet's guild. While a caller's secret is unset it is simply not a candidate,
 * so its requests fail the signature check: closed, not open.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger, mirrorFailureToLedger } = require('./ledger');
const { handleEventsCreate, handleEventsUpdate, handleEventsChannels } = require('./eventWebhook');
const { handleMessageSend } = require('./messageWebhook');
const { handleRecentMessages } = require('./recentMessages');
const cardtableStore = require('./cardtableStore');
const {
    handleSpaceProvision,
    handleSpaceRevoke,
    handleSpaceSweep,
    handleSpaceRepair,
} = require('./meetingSpace');

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

        case 'trigger_blocked_non_open_play':
            lines.push(`**Auto-signup blocked (non-Open-Play):** ${title}`);
            lines.push(
                'A "spot opened" email matched this row, but auto-signup ' +
                'is reserved for Open Play events. Row cleared — sign up ' +
                'manually if you want it.'
            );
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

/** The checkout's HEAD, or null (logged) when it is not a git checkout. */
function readCommit() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    } catch (err) {
        log.warn('readCommit', { error: err.message.split('\n')[0] });
        return null;
    }
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
 * Pin a cardtable-signed request to the cardtable guild.
 *
 * Returns { payload, guildId, setup } with guild_id (and, where the route has one, a
 * default channel_id) filled in, or { status, body } to refuse with.
 */
function scopeToCardtableGuild(route, payload) {
    const bound = cardtableStore.resolveBoundGuild();
    if (!bound.ok) {
        // Our misconfiguration, not the caller's: the guild has not been set
        // up, or two have. ERROR so it is found, but no ledger alert — nothing
        // was accepted, and the caller is told to retry later.
        log.error('cardtable_guild_unresolved', null, { route, reason: bound.error });
        return { status: 503, body: { success: false, error: bound.error } };
    }
    if (payload.guild_id != null && payload.guild_id !== bound.guildId) {
        log.fail('cardtable_guild_refused', { route, guildId: String(payload.guild_id) });
        return { status: 403, body: { success: false, error: 'guild_not_permitted' } };
    }
    const defaultChannel = {
        messages: bound.setup.channels.announcements,
        events: bound.setup.channels.events,
    }[route];
    return {
        guildId: bound.guildId,
        setup: bound.setup,
        payload: {
            ...payload,
            guild_id: bound.guildId,
            ...(defaultChannel && payload.channel_id == null ? { channel_id: defaultChannel } : {}),
        },
    };
}

/**
 * Build the HTTP handler. Factored out so tests can exercise it without
 * binding to a port.
 *
 * @param {object} opts
 * @param {import('discord.js').Client} opts.discordClient
 * @param {string} opts.channelId
 * @param {string} opts.secret             pickleball
 * @param {string} opts.eventsSecret       rally-api, on events + messages
 * @param {string} opts.cardtableSecret    cardtable, on events + messages
 * @param {string} opts.spacesSecret
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
function createHandler({ discordClient, channelId, secret, eventsSecret, cardtableSecret, spacesSecret, commit = readCommit() }) {
    const announceCallers = { events: eventsSecret, cardtable: cardtableSecret };
    return async function handler(req, res) {
        if (req.method === 'GET' && req.url === '/health') {
            const ready = discordClient.isReady();
            sendJson(res, ready ? 200 : 503, { status: ready ? 'ok' : 'not_ready', commit, discord: ready ? 'ready' : 'not_ready' });
            return;
        }
        // Route table: path → its name and the callers it accepts, each with
        // the secret that authenticates it. A route none of whose secrets are
        // set is simply absent (404) rather than half-configured.
        const routes = {
            '/api/pickleball/waitlist-outcome': { name: 'pickleball', callers: { pickleball: secret } },
            '/api/events/create': { name: 'events', callers: announceCallers },
            '/api/events/update': { name: 'events-update', callers: announceCallers },
            '/api/events/channels': { name: 'events-channels', callers: announceCallers },
            '/api/messages/send': { name: 'messages', callers: announceCallers },
            // Reads cardtable's own guild, so cardtable's secret only: rally-api
            // has no business reading that guild's chat.
            '/api/messages/recent': { name: 'messages-recent', method: 'GET', callers: { cardtable: cardtableSecret } },
            // Spaces carry their OWN secret, not the events one. A caller that
            // provisions private channels and kicks members should not thereby
            // be able to create guild events, and vice versa — one secret for
            // both would make the two capabilities inseparable.
            '/api/spaces/provision': { name: 'spaces-provision', callers: { spaces: spacesSecret } },
            '/api/spaces/revoke': { name: 'spaces-revoke', callers: { spaces: spacesSecret } },
            '/api/spaces/sweep': { name: 'spaces-sweep', callers: { spaces: spacesSecret } },
            '/api/spaces/repair': { name: 'spaces-repair', callers: { spaces: spacesSecret } },
        };
        const queryAt = req.url.indexOf('?');
        const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
        const query = queryAt === -1 ? '' : req.url.slice(queryAt + 1);
        const entry = routes[pathname] ?? null;
        const method = entry?.method ?? 'POST';
        // A POST route keeps matching its exact path only, as it always has.
        const matched = entry && req.method === method && (method === 'GET' || !query);
        const configured = matched ? Object.entries(entry.callers).filter(([, s]) => s) : [];
        if (!configured.length) {
            sendJson(res, 404, { success: false, error: 'not_found' });
            return;
        }
        const route = entry.name;

        let rawBody;
        if (method === 'GET') {
            rawBody = Buffer.from(query);
        } else {
            try {
                rawBody = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 413, { success: false, error: err.message });
                return;
            }
        }

        const sig = req.headers['x-hadoku-signature'];
        const caller = configured.find(([, s]) => verifySignature(rawBody, sig, s))?.[0] ?? null;
        if (!caller) {
            // A refused request, not an operational failure — the caller's
            // bug, answered with a 401.
            log.fail('invalid_signature', {
                route,
                callers: configured.map(([name]) => name).join(','),
                hasHeader: !!sig,
            });
            sendJson(res, 401, { success: false, error: 'invalid_signature' });
            return;
        }

        if (route === 'messages-recent') {
            const scoped = scopeToCardtableGuild(route, {});
            if (scoped.status) {
                sendJson(res, scoped.status, scoped.body);
                return;
            }
            try {
                const { status, body } = await handleRecentMessages(query, discordClient, {
                    guildId: scoped.guildId,
                    generalChannelId: scoped.setup.channels?.general,
                });
                sendJson(res, status, body);
            } catch (err) {
                // Nobody is owed anything here — cardtable drops the card and
                // asks again in a minute — so a log line, not a ledger alert.
                log.error('recent_messages_unhandled', err, {});
                sendJson(res, 500, { success: false, error: 'recent_messages_failed' });
            }
            return;
        }

        let payload;
        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch (err) {
            sendJson(res, 400, { success: false, error: 'invalid_json' });
            return;
        }
        // `null` and `42` are valid JSON, and every handler reads fields off
        // the payload — outside a try, in the cardtable scope step below.
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            sendJson(res, 400, { success: false, error: 'invalid_json' });
            return;
        }

        let scopedGuildId = null;
        if (caller === 'cardtable') {
            const scoped = scopeToCardtableGuild(route, payload);
            if (scoped.status) {
                sendJson(res, scoped.status, scoped.body);
                return;
            }
            payload = scoped.payload;
            scopedGuildId = scoped.guildId;
        }

        const spaceRoutes = {
            'spaces-provision': handleSpaceProvision,
            'spaces-revoke': handleSpaceRevoke,
            'spaces-sweep': handleSpaceSweep,
            'spaces-repair': handleSpaceRepair,
        };
        if (spaceRoutes[route]) {
            try {
                const { status, body } = await spaceRoutes[route](payload, discordClient);
                sendJson(res, status, body);
            } catch (err) {
                log.error('space_route_unhandled', err, { route });
                sendJson(res, 500, { success: false, error: 'space_request_failed' });
            }
            return;
        }

        if (route === 'events') {
            try {
                const { status, body } = await handleEventsCreate(payload, discordClient);
                sendJson(res, status, body);
            } catch (err) {
                log.error('events_create_unhandled', err, {});
                sendJson(res, 500, { success: false, error: 'event_create_failed' });
            }
            return;
        }

        if (route === 'events-update') {
            try {
                const { status, body } = await handleEventsUpdate(payload, discordClient);
                sendJson(res, status, body);
            } catch (err) {
                log.error('events_update_unhandled', err, {});
                sendJson(res, 500, { success: false, error: 'event_update_failed' });
            }
            return;
        }

        if (route === 'events-channels') {
            try {
                const { status, body } = await handleEventsChannels(payload, discordClient, {
                    guildId: scopedGuildId,
                });
                sendJson(res, status, body);
            } catch (err) {
                log.error('events_channels_unhandled', err, {});
                sendJson(res, 500, { success: false, error: 'channels_list_failed' });
            }
            return;
        }

        if (route === 'messages') {
            try {
                const { status, body } = await handleMessageSend(payload, discordClient, {
                    allowEmbeds: caller === 'cardtable',
                });
                sendJson(res, status, body);
            } catch (err) {
                log.error('message_send_unhandled', err, {});
                sendJson(res, 500, { success: false, error: 'message_send_failed' });
            }
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
            mirrorToLedger('archivebot.waitlist', `waitlist ${payload.kind}`, {
                kind: payload.kind,
                eventTitle: payload.event_title,
            });
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
            // The scraper is a cron with no-one watching its exit code, and a
            // waitlist outcome is time-critical by nature — a spot opened. If
            // this never reaches the channel, the ledger is the only trace.
            mirrorFailureToLedger('archivebot.waitlist', `waitlist ${payload.kind} not delivered`, {
                kind: payload.kind,
                channelId,
                error: err,
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
    const eventsSecret = process.env.ARCHIVEBOT_EVENTS_WEBHOOK_SECRET;
    const cardtableSecret = process.env.ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET;
    const spacesSecret = process.env.ARCHIVEBOT_SPACES_WEBHOOK_SECRET;

    // Each route needs its own config; the server starts if ANY route is
    // fully configured (the unconfigured ones 404). The old all-or-nothing
    // gate would have silently taken pickleball down while events rolled out.
    const pickleballReady = !!(secret && channelId);
    if (!pickleballReady && secret) {
        log.warn('pickleball_route_disabled', {
            reason: 'PICKLEBALL_CHANNEL_ID not set — pickleball route will 404',
        });
    }
    if (!cardtableSecret) {
        log.warn('cardtable_caller_disabled', {
            reason: 'ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET not set — cardtable-signed requests will 401',
        });
    }
    if (!pickleballReady && !eventsSecret && !cardtableSecret && !spacesSecret) {
        log.warn('webhook_disabled', {
            reason:
                'none of PICKLEBALL_WEBHOOK_SECRET+PICKLEBALL_CHANNEL_ID, ' +
                'ARCHIVEBOT_EVENTS_WEBHOOK_SECRET, ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET or ' +
                'ARCHIVEBOT_SPACES_WEBHOOK_SECRET set — webhook server will NOT start',
        });
        return null;
    }

    const handler = createHandler({
        discordClient,
        channelId,
        secret: pickleballReady ? secret : null,
        eventsSecret,
        cardtableSecret,
        spacesSecret,
    });
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
    scopeToCardtableGuild,
};
