/**
 * GET /api/messages/recent: cardtable's signed read of its own #general, as
 * plain text with no ids or links, avatars inlined, for hadoku-cardtable's
 * front page.
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
const { plainText, parseQuery } = require('../lib/recentMessages');
const cardtableStore = require('../lib/cardtableStore');
const { createMockChannel, createMockCollection } = require('./mocks/discord');

const EVENTS_SECRET = 'events-secret-value';
const CARDTABLE_SECRET = 'cardtable-secret-value';
const GUILD_ID = 'cardtable-guild-recent';
const OTHER_GUILD_ID = 'other-guild-recent';
const GENERAL = 'ch-general';
const ANNOUNCEMENTS = 'ch-announcements';
const USER_ID = '111111111111111111';
const BASE = Date.parse('2026-10-28T18:00:00Z');

function sign(material, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(material).digest('hex');
}

function request(handler, { method = 'GET', path: reqPath, signature }) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: server.address().port,
                    path: reqPath,
                    method,
                    headers: signature ? { 'x-hadoku-signature': signature } : {},
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
            req.end();
        });
    });
}

/** A signed GET, the way cardtable sends it: HMAC over the query string. */
function getRecent(handler, query = 'channel=general&limit=5', secret = CARDTABLE_SECRET) {
    return request(handler, { path: `/api/messages/recent?${query}`, signature: sign(query, secret) });
}

let seq = 0;
/** Discord's CDN URL for an author's avatar, the way discord.js builds it: it carries the user id. */
const avatarUrl = (author) => `https://cdn.discordapp.com/avatars/user-${author}/hash-${author}.webp?size=64`;
/** The bytes the fake CDN answers for `author`. */
const avatarBytes = (author) => Buffer.from(`webp-${author}`);
const avatarUri = (author) => `data:image/webp;base64,${avatarBytes(author).toString('base64')}`;

function message({ content, at = BASE + seq * 1000, author = 'alice', bot = false, system = false, mentions = {}, color = 0 }) {
    seq += 1;
    const displayAvatarURL = jest.fn(() => avatarUrl(author));
    return {
        id: `msg-${seq}`,
        content,
        createdTimestamp: at,
        system,
        author: { id: `user-${author}`, username: author.toLowerCase(), displayName: author, bot, avatar: 'avatar-hash' },
        member: { displayName: author, displayColor: color, displayAvatarURL },
        attachments: createMockCollection(),
        embeds: [],
        mentions: {
            users: new Map(),
            members: new Map(),
            roles: new Map(),
            channels: new Map(),
            ...mentions,
        },
        guild: null,
    };
}

function mockClient(messages, { generalGuild = GUILD_ID } = {}) {
    const fetchMessages = jest.fn(async () => createMockCollection(messages.map((m) => [m.id, m])));
    const channels = new Map([
        [GENERAL, createMockChannel({ id: GENERAL, name: 'general', guildId: generalGuild, messages: { fetch: fetchMessages } })],
        [ANNOUNCEMENTS, createMockChannel({ id: ANNOUNCEMENTS, name: 'announcements', guildId: GUILD_ID })],
    ]);
    return {
        fetchMessages,
        client: { channels: { fetch: jest.fn(async (id) => channels.get(id) ?? null) } },
    };
}

function handlerFor(client, { cardtableSecret = CARDTABLE_SECRET, eventsSecret = EVENTS_SECRET } = {}) {
    return createHandler({ discordClient: client, channelId: null, secret: null, eventsSecret, cardtableSecret, commit: 'test' });
}

function bind(channels = { announcements: ANNOUNCEMENTS, events: 'ch-events', general: GENERAL }) {
    cardtableStore.saveSetup(GUILD_ID, {
        appliedAt: new Date().toISOString(),
        appliedBy: 'owner',
        categories: {},
        channels,
        roles: {},
        invite: null,
    });
}

const outputDirs = [GUILD_ID, OTHER_GUILD_ID].map((id) => path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, id));

let cdn;
beforeEach(() => {
    seq = 0;
    bind();
    cdn = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const author = /hash-([^.]+)\.webp/.exec(url)?.[1];
        return author === 'broken'
            ? new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
            : new Response(avatarBytes(author), { headers: { 'content-type': 'image/webp' } });
    });
});

afterEach(() => {
    cdn.mockRestore();
    for (const dir of outputDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/messages/recent', () => {
    test('answers the newest messages, oldest first, as author/avatar/color/text/at only', async () => {
        const msgs = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((content) => message({ content }));
        const { client, fetchMessages } = mockClient(msgs.slice().reverse());

        const res = await getRecent(handlerFor(client), 'channel=general&limit=3');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            messages: [
                { author: 'alice', avatar: avatarUri('alice'), color: null, text: 'five', at: '2026-10-28T18:00:04Z' },
                { author: 'alice', avatar: avatarUri('alice'), color: null, text: 'six', at: '2026-10-28T18:00:05Z' },
                { author: 'alice', avatar: avatarUri('alice'), color: null, text: 'seven', at: '2026-10-28T18:00:06Z' },
            ],
        });
        expect(client.channels.fetch).toHaveBeenCalledWith(GENERAL);
        expect(fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('defaults to 5 and caps the limit at 10', async () => {
        const msgs = Array.from({ length: 20 }, (_, i) => message({ content: `m${i}` }));
        const { client } = mockClient(msgs);
        const handler = handlerFor(client);

        expect((await getRecent(handler, 'channel=general')).body.messages).toHaveLength(5);
        const capped = await getRecent(handler, 'channel=general&limit=50');
        expect(capped.body.messages.map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 10}`));
    });

    test('skips bots, system messages and attachment-only messages, and still fills the limit', async () => {
        const msgs = [
            message({ content: 'kept 1' }),
            message({ content: 'kept 2' }),
            message({ content: 'beep', author: 'ArchiveBot', bot: true }),
            message({ content: '', system: true }),
            message({ content: '' }),
        ];
        const { client } = mockClient(msgs);
        const res = await getRecent(handlerFor(client), 'channel=general&limit=2');
        expect(res.body.messages.map((m) => m.text)).toEqual(['kept 1', 'kept 2']);
    });

    test('carries no ids or links: the avatar is the image, not its URL', async () => {
        const msgs = [
            message({
                content: `hey <@${USER_ID}> see https://discord.com/channels/1/2/3`,
                mentions: { members: new Map([[USER_ID, { displayName: 'Bob' }]]) },
            }),
        ];
        const { client } = mockClient(msgs);
        const res = await getRecent(handlerFor(client));
        expect(res.body.messages).toEqual([
            { author: 'alice', avatar: avatarUri('alice'), color: null, text: 'hey @Bob see [link]', at: '2026-10-28T18:00:00Z' },
        ]);
        expect(JSON.stringify(res.body)).not.toMatch(/\d{17,}|cdn\.discordapp|user-|msg-/);
    });

    test("inlines each author's avatar once, at 64px static, and keeps it across calls", async () => {
        const msgs = [message({ content: 'a', author: 'dana' }), message({ content: 'b', author: 'dana' }), message({ content: 'c', author: 'eli' })];
        const { client } = mockClient(msgs);
        const handler = handlerFor(client);

        const res = await getRecent(handler);
        expect(res.body.messages.map((m) => m.avatar)).toEqual([avatarUri('dana'), avatarUri('dana'), avatarUri('eli')]);
        // Newest first, so dana's later message is the one read.
        expect(msgs[1].member.displayAvatarURL).toHaveBeenCalledWith({ extension: 'webp', size: 64, forceStatic: true });
        expect(cdn.mock.calls.map(([url]) => url)).toEqual([avatarUrl('eli'), avatarUrl('dana')]);

        await getRecent(handler);
        expect(cdn).toHaveBeenCalledTimes(2);
    });

    test('an avatar the CDN will not serve is null; the message still comes', async () => {
        const { client } = mockClient([message({ content: 'hi', author: 'broken' })]);
        const res = await getRecent(handlerFor(client));
        expect(res.body.messages).toEqual([{ author: 'broken', avatar: null, color: null, text: 'hi', at: '2026-10-28T18:00:00Z' }]);
    });

    test("the name colour is the author's role colour, null without one", async () => {
        const { client } = mockClient([message({ content: 'hi', author: 'fay', color: 0x1abc9c }), message({ content: 'yo', author: 'gus', color: 0x00000f })]);
        const res = await getRecent(handlerFor(client));
        expect(res.body.messages.map((m) => m.color)).toEqual(['#1abc9c', '#00000f']);
    });

    test('refuses an unsigned call, a wrong signature and the events secret with 401', async () => {
        const { client, fetchMessages } = mockClient([message({ content: 'secret chat' })]);
        const handler = handlerFor(client);
        const query = 'channel=general&limit=5';

        const unsigned = await request(handler, { path: `/api/messages/recent?${query}` });
        const forged = await request(handler, { path: `/api/messages/recent?${query}`, signature: sign(query, 'nope') });
        const events = await getRecent(handler, query, EVENTS_SECRET);
        // A signature over another query does not carry over to this one.
        const swapped = await request(handler, { path: '/api/messages/recent?channel=general&limit=10', signature: sign(query, CARDTABLE_SECRET) });

        for (const res of [unsigned, forged, events, swapped]) {
            expect(res).toEqual({ status: 401, body: { success: false, error: 'invalid_signature' } });
        }
        expect(fetchMessages).not.toHaveBeenCalled();
    });

    test('reads no channel but #general', async () => {
        const { client, fetchMessages } = mockClient([message({ content: 'hi' })]);
        const handler = handlerFor(client);
        for (const channel of ['announcements', GENERAL, ANNOUNCEMENTS]) {
            const res = await getRecent(handler, `channel=${channel}`);
            expect(res).toEqual({ status: 400, body: { success: false, error: 'channel_not_permitted' } });
        }
        expect(fetchMessages).not.toHaveBeenCalled();
    });

    test('refuses a #general that is not in the bound guild', async () => {
        const { client, fetchMessages } = mockClient([message({ content: 'hi' })], { generalGuild: OTHER_GUILD_ID });
        const res = await getRecent(handlerFor(client));
        expect(res).toEqual({ status: 503, body: { success: false, error: 'cardtable_general_unavailable' } });
        expect(fetchMessages).not.toHaveBeenCalled();
    });

    test('is 503 until /setup cardtable has bound a guild with a #general', async () => {
        const { client } = mockClient([]);
        bind({ announcements: ANNOUNCEMENTS });
        expect(await getRecent(handlerFor(client))).toEqual({
            status: 503,
            body: { success: false, error: 'cardtable_general_not_set_up' },
        });
        fs.rmSync(outputDirs[0], { recursive: true, force: true });
        expect(await getRecent(handlerFor(client))).toEqual({
            status: 503,
            body: { success: false, error: 'cardtable_guild_not_set_up' },
        });
    });

    test('is 404 while the cardtable secret is unset, and as a POST', async () => {
        const { client } = mockClient([]);
        expect((await getRecent(handlerFor(client, { cardtableSecret: null }))).status).toBe(404);
        const query = 'channel=general';
        const post = await request(handlerFor(client), { method: 'POST', path: `/api/messages/recent?${query}`, signature: sign(query, CARDTABLE_SECRET) });
        expect(post.status).toBe(404);
    });

    test('a POST route still matches its exact path only', async () => {
        const { client } = mockClient([]);
        const res = await request(handlerFor(client), { method: 'POST', path: '/api/messages/send?x=1', signature: sign('', CARDTABLE_SECRET) });
        expect(res.status).toBe(404);
    });
});

describe('parseQuery', () => {
    test.each([
        ['', { limit: 5 }],
        ['channel=general', { limit: 5 }],
        ['limit=1', { limit: 1 }],
        ['channel=general&limit=10', { limit: 10 }],
        ['limit=11', { limit: 10 }],
        ['limit=0', { error: 'invalid_limit' }],
        ['limit=-1', { error: 'invalid_limit' }],
        ['limit=3.5', { error: 'invalid_limit' }],
        ['limit=five', { error: 'invalid_limit' }],
        ['channel=announcements', { error: 'channel_not_permitted' }],
    ])('%s', (query, expected) => {
        expect(parseQuery(query)).toEqual(expected);
    });
});

describe('plainText', () => {
    const guild = {
        members: { cache: new Map([['222222222222222222', { displayName: 'Cached Carol' }]]) },
        roles: { cache: new Map([['333333333333333333', { name: 'Player' }]]) },
        channels: { cache: new Map([['444444444444444444', { name: 'looking-for-game' }]]) },
    };
    const text = (content, extra = {}) => plainText({ ...message({ content }), guild, ...extra });

    test('resolves mentions to names, from the message first and the guild cache second', () => {
        const msg = message({
            content: `<@${USER_ID}> <@!${USER_ID}> <@222222222222222222> <@&333333333333333333> <#444444444444444444>`,
            mentions: { users: new Map([[USER_ID, { displayName: 'bob_global' }]]) },
        });
        expect(plainText({ ...msg, guild })).toBe('@bob_global @bob_global @Cached Carol @Player #looking-for-game');
    });

    test('a mention it cannot resolve leaves a placeholder, never the id', () => {
        expect(text('<@999999999999999999> <@&999999999999999999> <#999999999999999999>')).toBe('@someone @role #channel');
    });

    test('emoji, slash commands and timestamps become what Discord shows', () => {
        expect(text('gg <:pog:555555555555555555> <a:dance:555555555555555556> try </draft start:666666666666666666> at <t:1793214000:R>'))
            .toBe('gg :pog: :dance: try /draft start at 2026-10-28T19:00:00Z');
    });

    test('links and spoilers are hidden', () => {
        expect(text('see <https://example.com/x> and http://a.b/c?d=1 but ||Bob wins|| ok')).toBe('see [link] and [link] but [spoiler] ok');
    });

    test('whitespace collapses and long text is cut to 200 characters', () => {
        expect(text('line one\n\n  line   two')).toBe('line one line two');
        const cut = text('🃏'.repeat(300));
        expect(Array.from(cut)).toHaveLength(200);
        expect(cut.endsWith('…')).toBe(true);
        expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
});
