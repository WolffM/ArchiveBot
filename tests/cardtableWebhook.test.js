/**
 * The cardtable caller on /api/messages/send and /api/events/*: its own
 * secret, scoped to the guild `/setup cardtable` bound, with embeds on
 * messages and nothing more.
 */

jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../lib/webhookServer');
const { validateEmbeds, EMBED_LIMITS } = require('../lib/messageWebhook');
const cardtableStore = require('../lib/cardtableStore');
const { createMockGuild, createMockChannel, createMockCollection } = require('./mocks/discord');

const EVENTS_SECRET = 'events-secret-value';
const CARDTABLE_SECRET = 'cardtable-secret-value';
const GUILD_ID = 'cardtable-guild-webhook';
const MEET_GUILD_ID = 'meet-guild-webhook';
const ANNOUNCEMENTS = 'ch-announcements';
const EVENTS = 'ch-events';
const GENERAL = 'ch-general';

// docs/releases/v0.33.0.md in hadoku-cardtable, verbatim below the heading:
// the first real payload this route will carry.
const V0_33_0_NOTES = `Card Table now has releases. This page is the first set of patch notes, and every update from here
on comes with one.

## New

- **A preview table** at \`hadoku.me/cardtable-ppe/\`. New work shows up there first, every time it's
  ready, so you can try it before it reaches the main table. Its rooms, drafts and tournaments are
  its own, and its games don't count toward your stats.
- **The main table only changes on release day.** No more updates landing in the middle of an
  evening's games. When it does change, these notes say what's new.`;

function releasePayload(overrides = {}) {
    return {
        source: 'cardtable',
        idempotencyKey: `cardtable-release-v0.33.0-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
        embeds: [
            {
                title: 'v0.33.0 — first versioned release',
                description: V0_33_0_NOTES,
                url: 'https://hadoku.me/cardtable/',
                color: 0x2f855a,
                footer: { text: 'Card Table v0.33.0' },
                timestamp: '2026-10-23T18:00:00Z',
            },
        ],
        ...overrides,
    };
}

function sign(body, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function post(handler, route, payload, secret = CARDTABLE_SECRET) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const raw = Buffer.from(JSON.stringify(payload));
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: server.address().port,
                    path: route,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': raw.length,
                        ...(secret ? { 'x-hadoku-signature': sign(raw, secret) } : {}),
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

function bindCardtableGuild() {
    cardtableStore.saveSetup(GUILD_ID, {
        appliedAt: new Date().toISOString(),
        appliedBy: 'owner',
        categories: {},
        channels: { announcements: ANNOUNCEMENTS, events: EVENTS, general: GENERAL },
        roles: { player: 'role-player', admin: 'role-admin' },
        invite: { code: 'abc', url: 'https://discord.gg/abc', channelId: GENERAL, roleId: 'role-player' },
    });
}

/** Channels in two guilds, so a cross-guild post is detectable. */
function mockClient() {
    const send = jest.fn(async () => ({ id: 'sent-message-id' }));
    const channel = (id, guildId) => createMockChannel({ id, name: id, guildId, send });
    const channels = new Map([
        [ANNOUNCEMENTS, channel(ANNOUNCEMENTS, GUILD_ID)],
        [EVENTS, channel(EVENTS, GUILD_ID)],
        [GENERAL, channel(GENERAL, GUILD_ID)],
        ['ch-meet', channel('ch-meet', MEET_GUILD_ID)],
    ]);
    const guilds = new Map(
        [GUILD_ID, MEET_GUILD_ID].map((id) => {
            const guild = createMockGuild({ id });
            guild.channels.cache = createMockCollection([...channels].filter(([, c]) => c.guildId === id));
            guild.channels.fetch = jest.fn(async (cid) => channels.get(cid) ?? null);
            return [id, guild];
        })
    );
    return {
        send,
        guilds,
        client: {
            user: { id: 'bot-user-id' },
            channels: { fetch: jest.fn(async (id) => channels.get(id) ?? null) },
            guilds: { cache: guilds, fetch: jest.fn(async (id) => guilds.get(id)) },
        },
    };
}

function handlerFor(client, { cardtableSecret = CARDTABLE_SECRET, eventsSecret = EVENTS_SECRET } = {}) {
    return createHandler({ discordClient: client, channelId: null, secret: null, eventsSecret, cardtableSecret });
}

const outputDirs = [GUILD_ID, MEET_GUILD_ID].map((id) => path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, id));

beforeEach(() => {
    process.env.ARCHIVEBOT_EVENT_GUILD_ID = MEET_GUILD_ID;
    process.env.ARCHIVEBOT_EVENT_CHANNEL_ID = 'ch-meet';
    bindCardtableGuild();
});

afterEach(() => {
    delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    delete process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
    for (const dir of outputDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the cardtable secret', () => {
    test('posts the v0.33.0 release notes as an embed into #announcements', async () => {
        const { client, send } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', releasePayload());

        expect(res).toEqual({ status: 200, body: { success: true, messageId: 'sent-message-id' } });
        expect(client.channels.fetch).toHaveBeenCalledWith(ANNOUNCEMENTS);
        const sent = send.mock.calls[0][0];
        expect(sent.content).toBeUndefined();
        expect(sent.embeds[0]).toEqual({
            title: 'v0.33.0 — first versioned release',
            description: V0_33_0_NOTES,
            url: 'https://hadoku.me/cardtable/',
            color: 0x2f855a,
            footer: { text: 'Card Table v0.33.0' },
            timestamp: '2026-10-23T18:00:00.000Z',
        });
        expect(sent.allowedMentions).toEqual({ parse: [] });
    });

    test('dedupes a repeated release key, as a reboot would send it', async () => {
        const { client, send } = mockClient();
        const handler = handlerFor(client);
        const payload = releasePayload({ idempotencyKey: 'cardtable-release-v0.33.0' });

        await post(handler, '/api/messages/send', payload);
        const again = await post(handler, '/api/messages/send', { ...payload, timestamp: Date.now() });

        expect(again.body).toEqual({ success: true, messageId: 'sent-message-id', deduped: true });
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('honours an explicit channel in its own guild', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', releasePayload({ channel_id: GENERAL }));
        expect(res.status).toBe(200);
        expect(client.channels.fetch).toHaveBeenCalledWith(GENERAL);
    });

    test("cannot reach meet's guild, by guild_id or by channel_id", async () => {
        const { client, send } = mockClient();
        const byGuild = await post(handlerFor(client), '/api/messages/send', releasePayload({ guild_id: MEET_GUILD_ID }));
        expect(byGuild).toEqual({ status: 403, body: { success: false, error: 'guild_not_permitted' } });

        const byChannel = await post(handlerFor(client), '/api/messages/send', releasePayload({ channel_id: 'ch-meet' }));
        expect(byChannel.body.error).toBe('channel_not_in_guild');
        expect(send).not.toHaveBeenCalled();
    });

    test('fails closed while ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET is unset', async () => {
        const { client, send } = mockClient();
        const res = await post(handlerFor(client, { cardtableSecret: null }), '/api/messages/send', releasePayload());
        expect(res).toEqual({ status: 401, body: { success: false, error: 'invalid_signature' } });
        expect(send).not.toHaveBeenCalled();
    });

    test('503 until a guild has been set up', async () => {
        fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, GUILD_ID), { recursive: true, force: true });
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', releasePayload());
        expect(res).toEqual({ status: 503, body: { success: false, error: 'cardtable_guild_not_set_up' } });
    });

    test('a non-object body is refused before the scope step reads it', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', null);
        expect(res).toEqual({ status: 400, body: { success: false, error: 'invalid_json' } });
    });
});

describe('the events secret is unchanged', () => {
    test('meet still posts plain text to its default guild', async () => {
        const { client, send } = mockClient();
        const res = await post(
            handlerFor(client),
            '/api/messages/send',
            { source: 'meet', idempotencyKey: 'meet-1', timestamp: Date.now(), content: 'Winner: Pizza' },
            EVENTS_SECRET
        );
        expect(res.status).toBe(200);
        expect(client.channels.fetch).toHaveBeenCalledWith('ch-meet');
        expect(send.mock.calls[0][0].embeds).toBeUndefined();
    });

    test('meet may not send embeds', async () => {
        const { client, send } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', releasePayload({ source: 'meet' }), EVENTS_SECRET);
        expect(res).toEqual({ status: 400, body: { success: false, error: 'embeds_not_permitted' } });
        expect(send).not.toHaveBeenCalled();
    });

    test('works with the cardtable secret unset', async () => {
        const { client } = mockClient();
        const res = await post(
            handlerFor(client, { cardtableSecret: null }),
            '/api/messages/send',
            { idempotencyKey: 'meet-2', timestamp: Date.now(), content: 'hi' },
            EVENTS_SECRET
        );
        expect(res.status).toBe(200);
    });

    test('the route 404s only when neither secret is set', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client, { cardtableSecret: null, eventsSecret: null }), '/api/messages/send', releasePayload());
        expect(res.status).toBe(404);
    });
});

describe('/api/events/* with the cardtable secret', () => {
    test('channels lists the cardtable guild, not the env default', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/events/channels', { timestamp: Date.now() });
        expect(res.status).toBe(200);
        expect(res.body.channels.map((c) => c.id).sort()).toEqual([ANNOUNCEMENTS, EVENTS, GENERAL].sort());
    });

    test("channels honours the request's guild_id when it is the cardtable guild", async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/events/channels', { timestamp: Date.now(), guild_id: GUILD_ID });
        expect(res.status).toBe(200);
        const refused = await post(handlerFor(client), '/api/events/channels', { timestamp: Date.now(), guild_id: MEET_GUILD_ID });
        expect(refused.status).toBe(403);
    });

    test('meet still lists only its env guild', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/events/channels', { timestamp: Date.now() }, EVENTS_SECRET);
        expect(res.body.channels.map((c) => c.id)).toEqual(['ch-meet']);
    });

    test('create lands in the cardtable guild and announces in #events', async () => {
        const { client, guilds } = mockClient();
        const start = Date.now() + 86_400_000;
        const res = await post(handlerFor(client), '/api/events/create', {
            source: 'cardtable',
            idempotencyKey: 'cardtable-tournament-1',
            timestamp: Date.now(),
            name: 'Friday draft',
            startTime: new Date(start).toISOString(),
            endTime: new Date(start + 3 * 3_600_000).toISOString(),
            location: 'hadoku.me/cardtable',
        });
        expect(res.status).toBe(200);
        expect(guilds.get(GUILD_ID).scheduledEvents.create).toHaveBeenCalled();
        expect(guilds.get(MEET_GUILD_ID).scheduledEvents.create).not.toHaveBeenCalled();
        const scheduler = require('../lib/scheduler');
        const item = scheduler.loadScheduledItems(GUILD_ID).items.find((i) => i.sourceKey === 'cardtable-tournament-1');
        expect(item.channelId).toBe(EVENTS);
    });

    test('update is scoped too', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/events/update', {
            idempotencyKey: 'u1',
            timestamp: Date.now(),
            guild_id: MEET_GUILD_ID,
            scheduledEventId: 'e1',
            cancel: true,
        });
        expect(res.status).toBe(403);
    });
});

describe('validateEmbeds', () => {
    const ok = (embed) => validateEmbeds([embed]);

    test.each([
        [{ title: 't', image: { url: 'https://x' } }, 'embeds[0].image is not accepted'],
        [{ title: 't', author: { name: 'a' } }, 'embeds[0].author is not accepted'],
        [{ title: 't', thumbnail: { url: 'https://x' } }, 'embeds[0].thumbnail is not accepted'],
        [{ title: 't', footer: { text: 'f', icon_url: 'https://x' } }, 'embeds[0].footer.icon_url is not accepted'],
        [{ title: 't', fields: [{ name: 'n', value: 'v', url: 'x' }] }, 'embeds[0].fields[0].url is not accepted'],
        [{ title: 't', url: 'javascript:alert(1)' }, 'embeds[0].url must be an http(s) URL'],
        [{ title: 't', url: 'not a url' }, 'embeds[0].url must be an http(s) URL'],
        [{ title: 't', color: 0x1000000 }, 'embeds[0].color must be an integer 0-16777215'],
        [{ title: 't', color: '#fff' }, 'embeds[0].color must be an integer 0-16777215'],
        [{ title: 't', timestamp: 'soon' }, 'embeds[0].timestamp must be an ISO 8601 string'],
        [{ title: 't', fields: [{ name: 'n', value: 'v', inline: 'yes' }] }, 'embeds[0].fields[0].inline must be a boolean'],
        [{ url: 'https://x', color: 1 }, 'embeds[0] needs a title, description or fields'],
        [{ title: '   ' }, 'embeds[0].title must be 1-256 chars'],
    ])('refuses %j', (embed, detail) => {
        expect(ok(embed)).toEqual({ ok: false, detail });
    });

    test('description is capped at 4096', () => {
        expect(ok({ description: 'x'.repeat(4096) }).ok).toBe(true);
        expect(ok({ description: 'x'.repeat(4097) }).detail).toBe('embeds[0].description must be 1-4096 chars');
    });

    test('fields are capped at 25', () => {
        const field = { name: 'n', value: 'v' };
        expect(ok({ fields: Array(25).fill(field) }).ok).toBe(true);
        expect(ok({ fields: Array(26).fill(field) }).detail).toBe('embeds[0].fields must be an array of at most 25');
    });

    test('the 6000-char total spans every embed', () => {
        const big = { description: 'x'.repeat(3001) };
        expect(validateEmbeds([big, big]).detail).toBe('embeds total 6002 chars; the limit is 6000');
    });

    test('at most 10 embeds, at least 1', () => {
        expect(validateEmbeds([]).ok).toBe(false);
        expect(validateEmbeds(Array(EMBED_LIMITS.embeds + 1).fill({ title: 't' })).ok).toBe(false);
    });

    test('a refusal names the offending path over HTTP', async () => {
        const { client } = mockClient();
        const res = await post(handlerFor(client), '/api/messages/send', releasePayload({ embeds: [{ title: 't', image: {} }] }));
        expect(res).toEqual({ status: 400, body: { success: false, error: 'invalid_embeds', detail: 'embeds[0].image is not accepted' } });
    });

    test('content and embeds together are fine; content alone still is', async () => {
        const { client, send } = mockClient();
        await post(handlerFor(client), '/api/messages/send', releasePayload({ content: 'v0.33.0 is out' }));
        expect(send.mock.calls[0][0]).toMatchObject({ content: 'v0.33.0 is out', embeds: [expect.any(Object)] });
    });
});
