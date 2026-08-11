const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../lib/webhookServer');
const { validateEventPayload } = require('../lib/eventWebhook');
const { createMockGuild, createMockChannel, createMockCollection } = require('./mocks/discord');
const scheduler = require('../lib/scheduler');

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

    test('creates the advance-warning companion when remindBeforeMs is given', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        const payload = validPayload({ remindBeforeMs: 3600 * 1000 });
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.reminderCreated).toBe(true);

        const stored = JSON.parse(
            fs.readFileSync(path.join(OUTPUT_DIR, 'scheduled.json'), 'utf8')
        );
        const items = stored.items.filter((i) => i.sourceKey === payload.idempotencyKey);
        expect(items).toHaveLength(2);

        const reminder = items.find((i) => i.type === 'event_reminder');
        expect(reminder).toBeTruthy();
        expect(reminder.scheduledEventId).toBe(res.body.eventId);
        expect(reminder.channelId).toBe(CHANNEL_ID);
        expect(reminder.remindBeforeMs).toBe(3600 * 1000);
        expect(reminder.active).toBe(true);
        // Fires one lead time ahead of the event, not at it.
        expect(new Date(reminder.triggerAt).getTime()).toBe(
            new Date(payload.startTime).getTime() - 3600 * 1000
        );
        // Distinct ids, or /remove and the store's own bookkeeping collide.
        expect(items[0].id).not.toBe(items[1].id);
    });

    test('creates no companion when remindBeforeMs is omitted', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        const payload = validPayload();
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.reminderCreated).toBe(false);
        const stored = JSON.parse(
            fs.readFileSync(path.join(OUTPUT_DIR, 'scheduled.json'), 'utf8')
        );
        const items = stored.items.filter((i) => i.sourceKey === payload.idempotencyKey);
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('event');
    });

    test('skips the companion when the lead time has already passed', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        // Event in 30 minutes, reminder asked for an hour ahead — that moment
        // is behind us, and firing it would announce a lead time already spent.
        const start = new Date(Date.now() + 30 * 60 * 1000);
        const payload = validPayload({
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 3600 * 1000).toISOString(),
            remindBeforeMs: 3600 * 1000,
        });
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.reminderCreated).toBe(false);
        const stored = JSON.parse(
            fs.readFileSync(path.join(OUTPUT_DIR, 'scheduled.json'), 'utf8')
        );
        const items = stored.items.filter((i) => i.sourceKey === payload.idempotencyKey);
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('event');
    });

    test('400 on a malformed remindBeforeMs rather than a NaN reminder later', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const handler = makeHandler(guild);
        // Infinity is absent deliberately: JSON.stringify turns it into null,
        // which is the documented "no reminder wanted" case, not a bad value.
        for (const bad of ['3600000', -1, 0, 40 * 24 * 3600 * 1000]) {
            const payload = validPayload({ remindBeforeMs: bad });
            const res = await postWithHandler(handler, '/api/events/create', payload, {
                'x-hadoku-signature': signBody(JSON.stringify(payload)),
            });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_remind_before');
        }
        expect(guild.scheduledEvents.create).not.toHaveBeenCalled();
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

describe('POST /api/events/channels', () => {
    // A guild whose channel cache spans everything the picker must survive:
    // two postable text channels (one nested under a category), a text channel
    // the bot cannot post in, and a non-text channel.
    function guildWithChannels() {
        const guild = createMockGuild({ id: GUILD_ID });
        const add = (channel) => guild.channels.cache.set(channel.id, channel);
        add(createMockChannel({ id: 'c-general', name: 'general', guildId: GUILD_ID }));
        add(
            createMockChannel({
                id: 'c-walks',
                name: 'walks',
                guildId: GUILD_ID,
                parent: { id: 'cat-1', name: 'Outdoors' },
                parentId: 'cat-1',
            })
        );
        add(
            createMockChannel({
                id: 'c-locked',
                name: 'mods-only',
                guildId: GUILD_ID,
                permissionsFor: jest.fn(() => ({ has: () => false })),
            })
        );
        add(createMockChannel({ id: 'c-voice', name: 'Voice Chat', guildId: GUILD_ID, type: 2 }));
        add(createMockChannel({ id: 'cat-1', name: 'Outdoors', guildId: GUILD_ID, type: 4 }));
        // A public thread hanging off a text channel. This guild's real event
        // announcements live in one of these, so the picker has to offer them.
        add(
            createMockChannel({
                id: 'c-thread',
                name: 'party gamers',
                guildId: GUILD_ID,
                type: 11,
                isThread: () => true,
                locked: false,
                parent: { id: 'c-general', name: 'general' },
                parentId: 'c-general',
            })
        );
        // ...but not a locked one, which rejects sends from everyone but mods.
        add(
            createMockChannel({
                id: 'c-thread-locked',
                name: 'old-planning',
                guildId: GUILD_ID,
                type: 11,
                isThread: () => true,
                locked: true,
                parent: { id: 'c-general', name: 'general' },
                parentId: 'c-general',
            })
        );
        return guild;
    }

    beforeEach(() => {
        process.env.ARCHIVEBOT_EVENT_GUILD_ID = GUILD_ID;
    });

    afterAll(() => {
        delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
    });

    test('404 when the events secret is not configured', async () => {
        const handler = createHandler({
            discordClient: mockClient(guildWithChannels()),
            channelId: 'chan',
            secret: PICKLEBALL_SECRET,
            eventsSecret: null,
        });
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(404);
    });

    test('401 without a signature', async () => {
        const handler = makeHandler(guildWithChannels());
        const res = await postWithHandler(handler, '/api/events/channels', {
            source: 'meet',
            timestamp: Date.now(),
        });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_signature');
    });

    test('401 with a signature from the wrong (pickleball) secret', async () => {
        const handler = makeHandler(guildWithChannels());
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload), PICKLEBALL_SECRET),
        });
        expect(res.status).toBe(401);
    });

    test('400 on a stale timestamp — a captured read stays replayable otherwise', async () => {
        const handler = makeHandler(guildWithChannels());
        const payload = { source: 'meet', timestamp: Date.now() - 30 * 60 * 1000 };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('stale_timestamp');
    });

    test('lists only postable text channels, category-then-name, with parentName', async () => {
        const handler = makeHandler(guildWithChannels());
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.channels).toEqual([
            { id: 'c-general', name: 'general', parentName: null },
            { id: 'c-thread', name: 'party gamers', parentName: 'general' },
            { id: 'c-walks', name: 'walks', parentName: 'Outdoors' },
        ]);
    });

    // A forum post is a thread, and only ACTIVE threads reach the gateway
    // cache. This guild organizes topics as forum posts, so before archived
    // posts were fetched the picker showed a fraction of the forum and hid
    // channels people actually use.
    function archivedPost(n) {
        return createMockChannel({
            id: `t-arch-${n}`,
            name: `post ${String(n).padStart(2, '0')}`,
            guildId: GUILD_ID,
            type: 11,
            isThread: () => true,
            locked: false,
            parent: { id: 'c-forum', name: 'more-channels' },
            parentId: 'c-forum',
        });
    }

    function guildWithForum(archived, { fetchThrows = false } = {}) {
        const guild = createMockGuild({ id: GUILD_ID });
        const add = (channel) => guild.channels.cache.set(channel.id, channel);
        add(createMockChannel({ id: 'c-general', name: 'general', guildId: GUILD_ID }));
        add(
            createMockChannel({
                id: 'c-forum',
                name: 'more-channels',
                guildId: GUILD_ID,
                type: 15, // ChannelType.GuildForum — holds posts, not messages
                threads: {
                    fetchArchived: jest.fn(async () => {
                        if (fetchThrows) throw new Error('missing access');
                        return {
                            threads: createMockCollection(archived.map((t) => [t.id, t])),
                            hasMore: false,
                        };
                    }),
                },
            })
        );
        return guild;
    }

    test('offers archived forum posts — posting to one unarchives it', async () => {
        const handler = makeHandler(guildWithForum([archivedPost(1), archivedPost(2)]));
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.channels).toEqual([
            { id: 'c-general', name: 'general', parentName: null },
            { id: 't-arch-1', name: 'post 01', parentName: 'more-channels' },
            { id: 't-arch-2', name: 'post 02', parentName: 'more-channels' },
        ]);
        // The forum itself is not postable — posts go in it, messages do not.
        expect(res.body.channels.some((c) => c.id === 'c-forum')).toBe(false);
    });

    test('caps one parent at 25 threads so a big forum cannot bury the channels', async () => {
        const archived = Array.from({ length: 40 }, (_, i) => archivedPost(i + 1));
        const handler = makeHandler(guildWithForum(archived));
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.channels.filter((c) => c.parentName === 'more-channels')).toHaveLength(25);
        // The plain channel still makes it out — that is the point of the cap.
        expect(res.body.channels.some((c) => c.id === 'c-general')).toBe(true);
    });

    test('a forum the bot cannot read does not cost the caller the whole list', async () => {
        const handler = makeHandler(guildWithForum([], { fetchThrows: true }));
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        expect(res.body.channels).toEqual([{ id: 'c-general', name: 'general', parentName: null }]);
    });

    test('ignores a caller-supplied guild_id — this is not an enumeration oracle', async () => {
        const guild = guildWithChannels();
        const client = mockClient(guild);
        const handler = createHandler({
            discordClient: client,
            channelId: null,
            secret: PICKLEBALL_SECRET,
            eventsSecret: EVENTS_SECRET,
        });
        const payload = { source: 'meet', timestamp: Date.now(), guild_id: 'some-other-guild' };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });

        expect(res.status).toBe(200);
        // The configured guild's channels, and no lookup of the requested one.
        expect(res.body.channels.map((c) => c.id)).toEqual(['c-general', 'c-thread', 'c-walks']);
        expect(client.guilds.fetch).not.toHaveBeenCalledWith('some-other-guild');
    });

    test('500 when no target guild is configured', async () => {
        delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
        const handler = makeHandler(guildWithChannels());
        const payload = { source: 'meet', timestamp: Date.now() };
        const res = await postWithHandler(handler, '/api/events/channels', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('event_target_not_configured');
    });

    test('GET is not a route — the HMAC signs a body a GET does not have', async () => {
        const handler = makeHandler(guildWithChannels());
        const res = await new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                http.get(
                    { host: '127.0.0.1', port, path: '/api/events/channels' },
                    (r) => {
                        r.resume();
                        r.on('end', () => {
                            server.close();
                            resolve({ status: r.statusCode });
                        });
                    }
                ).on('error', (err) => {
                    server.close();
                    reject(err);
                });
            });
        });
        expect(res.status).toBe(404);
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

/**
 * The webhook and the scheduler were tested in separate files with mocks that
 * never met, which is exactly why webhook-created events shipped for months
 * with no advance reminder at all. These drive one payload all the way to the
 * message text.
 */
describe('webhook event → scheduler tick (end to end)', () => {
    let announceChannel;

    function tickClient(guild) {
        return {
            user: { id: 'bot-user-id' },
            guilds: { cache: createMockCollection([[GUILD_ID, guild]]) },
            channels: {
                fetch: jest.fn(async (id) => {
                    if (id === CHANNEL_ID) return announceChannel;
                    const err = new Error('Unknown Channel');
                    err.code = 10003;
                    throw err;
                }),
            },
        };
    }

    async function createThenFire(guild, { subscribers = [] } = {}) {
        const handler = makeHandler(guild);
        const payload = validPayload({ remindBeforeMs: 3600 * 1000 });
        const res = await postWithHandler(handler, '/api/events/create', payload, {
            'x-hadoku-signature': signBody(JSON.stringify(payload)),
        });
        expect(res.status).toBe(200);

        const scheduledEvent = guild.scheduledEvents.cache.get(res.body.eventId);
        for (const id of subscribers) scheduledEvent._addSubscriber(id);

        // Bring the reminder due instead of waiting an hour for it.
        const data = scheduler.loadScheduledItems(GUILD_ID);
        const reminder = data.items.find((i) => i.type === 'event_reminder');
        expect(reminder).toBeTruthy();
        reminder.triggerAt = new Date(Date.now() - 1000).toISOString();
        // Keep the event item itself out of this tick.
        data.items.find((i) => i.type === 'event').active = false;
        scheduler.saveScheduledItems(GUILD_ID, data);

        // initializeScheduler kicks off an un-awaited startup check and
        // checkAllItems guards on an isChecking flag, so calling it again here
        // would return instantly against the in-flight one and assert on
        // nothing. Drain turns until the post lands instead.
        scheduler.initializeScheduler(tickClient(guild));
        for (let i = 0; i < 50 && announceChannel.send.mock.calls.length === 0; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        return payload;
    }

    beforeEach(() => {
        process.env.ARCHIVEBOT_EVENT_GUILD_ID = GUILD_ID;
        process.env.ARCHIVEBOT_EVENT_CHANNEL_ID = CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
        announceChannel = createMockChannel({ id: CHANNEL_ID, guildId: GUILD_ID });
    });

    afterEach(() => {
        scheduler.stopScheduler();
    });

    afterAll(() => {
        delete process.env.ARCHIVEBOT_EVENT_GUILD_ID;
        delete process.env.ARCHIVEBOT_EVENT_CHANNEL_ID;
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    });

    test('posts an advance reminder that never @-mentions the bot itself', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        const payload = await createThenFire(guild);

        expect(announceChannel.send).toHaveBeenCalledTimes(1);
        const sent = announceChannel.send.mock.calls[0][0];
        expect(sent.content).toContain(payload.name);
        expect(sent.content).toContain('starts in 1h');
        // creatorId is the bot on this path — mentioning it would open every
        // meet reminder by pinging ArchiveBot.
        expect(sent.content).not.toContain('<@bot-user-id>');
        expect(sent.allowedMentions.users).not.toContain('bot-user-id');
        // No mentions at all here, so no dangling blank line either.
        expect(sent.content.startsWith('**Reminder:**')).toBe(true);
        expect(sent.content).not.toContain('NaN');
    });

    test('still mentions the humans who marked themselves interested', async () => {
        const guild = createMockGuild({ id: GUILD_ID });
        await createThenFire(guild, { subscribers: ['human-1', 'human-2'] });

        const sent = announceChannel.send.mock.calls[0][0];
        expect(sent.content).toContain('<@human-1>');
        expect(sent.content).toContain('<@human-2>');
        expect(sent.content).not.toContain('<@bot-user-id>');
        expect(sent.allowedMentions.users.sort()).toEqual(['human-1', 'human-2']);
    });
});
