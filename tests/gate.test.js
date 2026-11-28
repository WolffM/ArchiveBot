/**
 * The honeypot and the verify message (lib/gate.js), through the real invite
 * attribution (lib/meetingSpaceReaper.js) and a real HTTP listener standing in
 * for the emergency webhook.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Collection, PermissionsBitField } = require('discord.js');
const reaper = require('../lib/meetingSpaceReaper');
const gate = require('../lib/gate');

const OWNER = '100000000000000001';
const ADMIN = '100000000000000002';
const STRANGER = '100000000000000003';
const INVITER = '100000000000000004';
const BOT = '100000000000000009';
const HONEYPOT = 'ch-honeypot';

let seq = 0;

// ---------------------------------------------------------------- the webhook

let server;
let received;
let webhookStatus;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push({ path: req.url, body: JSON.parse(body) });
            res.writeHead(webhookStatus).end();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
    received = [];
    webhookStatus = 204;
    process.env.ARCHIVEBOT_EMERGENCY_WEBHOOK = `http://127.0.0.1:${server.address().port}/api/webhooks/1/token`;
    reaper.inviteCache.clear();
    reaper.inviteDetails.clear();
});

afterEach(() => {
    delete process.env.ARCHIVEBOT_EMERGENCY_WEBHOOK;
});

// ---------------------------------------------------------------- fake guild

function invite(code, uses, inviterId = INVITER) {
    return { code, uses, inviter: { id: inviterId, tag: 'inviter#0001' }, channel: { id: 'ch-general' } };
}

function makeGuild({ invites = [], botAlerts = null } = {}) {
    const id = `guild-${++seq}`;
    let live = invites;
    const members = new Map();
    const guild = {
        id,
        name: 'Test *Server*',
        ownerId: OWNER,
        invites: { fetch: jest.fn(async () => new Collection(live.map((i) => [i.code, i]))) },
        channels: { cache: new Collection(botAlerts ? [[botAlerts.id, botAlerts]] : []) },
        members: {
            me: {
                id: BOT,
                permissions: new PermissionsBitField(PermissionsBitField.All),
                roles: { highest: { position: 5 } },
            },
            fetch: jest.fn(async (userId) => {
                if (members.has(userId)) return members.get(userId);
                throw Object.assign(new Error('Unknown Member'), { code: 10007 });
            }),
            fetchMe: jest.fn(),
        },
        fetchOwner: jest.fn(async () => ({ send: jest.fn() })),
        setInvites(next) { live = next; },
        addMember(userId, { kickable = true, roles = [] } = {}) {
            const member = {
                id: userId,
                guild,
                kickable,
                joinedTimestamp: Date.parse('2026-11-27T10:00:00Z'),
                kick: jest.fn(async () => {}),
                roles: {
                    cache: new Collection(roles.map((r) => [r, { id: r, name: r }])),
                    add: jest.fn(async () => {}),
                },
            };
            members.set(userId, member);
            return member;
        },
    };
    return guild;
}

function post(guild, userId, { channelId = HONEYPOT, content = 'free nitro @everyone https://scam.example' } = {}) {
    return {
        id: `msg-${++seq}`,
        guild,
        channelId,
        channel: { name: 'general_' },
        content,
        attachments: new Collection(),
        author: { id: userId, bot: false, tag: 'spammer#1234', createdTimestamp: Date.parse('2026-11-27T09:00:00Z') },
        member: guild.addMember(userId),
        delete: jest.fn(async () => {}),
    };
}

function bindHoneypot(guild) {
    gate.save(guild.id, { honeypot: { channelId: HONEYPOT, setAt: new Date().toISOString(), setBy: OWNER }, verify: null, joins: {} });
}

async function joinThrough(guild, userId, after) {
    const member = guild.addMember(userId);
    guild.setInvites(after);
    const attribution = await reaper.attributeJoin(member);
    gate.recordJoin(member, attribution);
    return attribution;
}

// ---------------------------------------------------------------- attribution

describe('a join records which invite it used and who made it', () => {
    test('an ordinary invite whose use count went up', async () => {
        const guild = makeGuild({ invites: [invite('abc', 3), invite('def', 0, OWNER)] });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);

        const attribution = await joinThrough(guild, STRANGER, [invite('abc', 4), invite('def', 0, OWNER)]);

        expect(attribution).toEqual({ code: 'abc', inviterId: INVITER, inviterTag: 'inviter#0001', channelId: 'ch-general' });
        expect(gate.load(guild.id).joins[STRANGER]).toMatchObject({ code: 'abc', inviterId: INVITER });
    });

    test('a single-use invite that vanished still names its creator', async () => {
        const guild = makeGuild({ invites: [invite('once', 0), invite('keep', 2, OWNER)] });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);

        const attribution = await joinThrough(guild, STRANGER, [invite('keep', 2, OWNER)]);

        expect(attribution).toMatchObject({ code: 'once', inviterId: INVITER });
    });

    test('an invite created after the snapshot is attributable from its first use', async () => {
        const guild = makeGuild({ invites: [invite('old', 1, OWNER)] });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);
        reaper.noteInviteCreated({ ...invite('fresh', 0), guild: { id: guild.id } });

        const attribution = await joinThrough(guild, STRANGER, [invite('old', 1, OWNER), invite('fresh', 1)]);

        expect(attribution).toMatchObject({ code: 'fresh', inviterId: INVITER });
    });

    test('two invites moving at once is unknown, with the reason, never a guess', async () => {
        const guild = makeGuild({ invites: [invite('a', 0), invite('b', 0)] });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);

        const attribution = await joinThrough(guild, STRANGER, [invite('a', 1), invite('b', 1)]);

        expect(attribution.code).toBeNull();
        expect(gate.load(guild.id).joins[STRANGER]).toMatchObject({ code: null, reason: expect.stringContaining('no single invite') });
    });

    test('nothing is recorded in a guild without a honeypot', async () => {
        const guild = makeGuild({ invites: [invite('abc', 0)] });
        await reaper.cacheGuildInvites(guild);
        await joinThrough(guild, STRANGER, [invite('abc', 1)]);
        expect(fs.existsSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, guild.id, 'gate.json'))).toBe(false);
    });

    test('a member who leaves is forgotten, and old joins age out', async () => {
        const guild = makeGuild({ invites: [invite('abc', 0)] });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);
        await joinThrough(guild, STRANGER, [invite('abc', 1)]);

        gate.forgetJoin({ id: STRANGER, guild });
        expect(gate.load(guild.id).joins[STRANGER]).toBeUndefined();

        const old = gate.load(guild.id);
        old.joins.ancient = { at: new Date(Date.now() - gate.JOIN_TTL_MS - 1000).toISOString(), code: 'x' };
        gate.save(guild.id, old);
        expect(gate.load(guild.id).joins.ancient).toBeUndefined();
    });
});

// ---------------------------------------------------------------- honeypot

describe('a post in the honeypot', () => {
    async function trippedBy(userId, guildOpts) {
        const guild = makeGuild({ invites: [invite('abc', 0)], ...guildOpts });
        bindHoneypot(guild);
        await reaper.cacheGuildInvites(guild);
        await joinThrough(guild, userId, [invite('abc', 1)]);
        const message = post(guild, userId);
        const handled = await gate.handleHoneypotMessage(message);
        return { guild, message, handled };
    }

    test('kicks the poster, deletes the post, and sends an emergency notice naming the invite and its creator', async () => {
        const { message, handled } = await trippedBy(STRANGER);

        expect(handled).toBe(true);
        expect(message.delete).toHaveBeenCalled();
        expect(message.member.kick).toHaveBeenCalledWith(expect.stringContaining('honeypot'));
        expect(received).toHaveLength(1);
        const { body } = received[0];
        expect(body.allowed_mentions).toEqual({ parse: [] });
        expect(body.content).toContain('Honeypot tripped in Test \\*Server\\*');
        expect(body.content).toContain(`<@${STRANGER}> \`${STRANGER}\``);
        expect(body.content).toContain(`\`abc\` created by **inviter#0001** (<@${INVITER}> \`${INVITER}\`) for <#ch-general>`);
        expect(body.content).toContain('**Action:** kicked');
        expect(body.content).toContain('free nitro @everyone');
    });

    test('an admin is not kicked: the notice reads as a test', async () => {
        const { message } = await trippedBy(OWNER);

        expect(message.member.kick).not.toHaveBeenCalled();
        expect(message.delete).not.toHaveBeenCalled();
        expect(received[0].body.content).toContain('they are an admin, so this reads as a test');
    });

    test('a member the bot cannot kick is reported as not kicked', async () => {
        const guild = makeGuild();
        bindHoneypot(guild);
        const message = post(guild, STRANGER);
        message.member.kickable = false;

        await gate.handleHoneypotMessage(message);

        expect(message.member.kick).not.toHaveBeenCalled();
        expect(received[0].body.content).toContain('NOT kicked: my role is not above theirs');
        // No join on record: they joined before the honeypot existed.
        expect(received[0].body.content).toContain('**Invite:** unknown: they joined before the honeypot was set up');
    });

    test('a post in any other channel is left alone', async () => {
        const guild = makeGuild();
        bindHoneypot(guild);
        const message = post(guild, STRANGER, { channelId: 'ch-general' });

        expect(await gate.handleHoneypotMessage(message)).toBe(false);
        expect(message.member.kick).not.toHaveBeenCalled();
        expect(received).toHaveLength(0);
    });

    test('with no emergency channel configured the notice goes to #bot-alerts', async () => {
        delete process.env.ARCHIVEBOT_EMERGENCY_WEBHOOK;
        const alerts = { id: 'ch-alerts', name: 'bot-alerts', isThread: () => false, send: jest.fn(async () => ({})) };

        const { message } = await trippedBy(STRANGER, { botAlerts: alerts });

        expect(message.member.kick).toHaveBeenCalled();
        expect(alerts.send).toHaveBeenCalledWith({ content: expect.stringContaining('Honeypot tripped') });
    });

    test('an emergency webhook that refuses falls back the same way', async () => {
        webhookStatus = 404;
        const alerts = { id: 'ch-alerts', name: 'bot-alerts', isThread: () => false, send: jest.fn(async () => ({})) };

        await trippedBy(STRANGER, { botAlerts: alerts });

        expect(received).toHaveLength(1);
        expect(alerts.send).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------- verify

describe('the verify message', () => {
    function bindVerify(guild) {
        gate.save(guild.id, { honeypot: null, verify: { channelId: 'ch-verify', messageId: 'msg-verify', roleId: 'role-member' }, joins: {} });
    }

    function reactionOn(guild, messageId) {
        return { message: { id: messageId, guildId: guild.id }, client: { guilds: { cache: new Map([[guild.id, guild]]) } } };
    }

    test('a reaction gives the role', async () => {
        const guild = makeGuild();
        bindVerify(guild);
        const member = guild.addMember(STRANGER);

        expect(await gate.handleVerifyReaction(reactionOn(guild, 'msg-verify'), { id: STRANGER, bot: false })).toBe(true);
        expect(member.roles.add).toHaveBeenCalledWith('role-member', expect.any(String));
    });

    test('someone who already has it is left alone', async () => {
        const guild = makeGuild();
        bindVerify(guild);
        const member = guild.addMember(STRANGER, { roles: ['role-member'] });

        await gate.handleVerifyReaction(reactionOn(guild, 'msg-verify'), { id: STRANGER, bot: false });
        expect(member.roles.add).not.toHaveBeenCalled();
    });

    test('a reaction on any other message, or by a bot, does nothing', async () => {
        const guild = makeGuild();
        bindVerify(guild);
        const member = guild.addMember(STRANGER);

        expect(await gate.handleVerifyReaction(reactionOn(guild, 'msg-other'), { id: STRANGER, bot: false })).toBe(false);
        expect(await gate.handleVerifyReaction(reactionOn(guild, 'msg-verify'), { id: BOT, bot: true })).toBe(false);
        expect(member.roles.add).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------- /gate

describe('/gate', () => {
    function interaction(guild, { mode, role = null, text = null, channelId = 'ch-verify' }) {
        const channel = {
            id: channelId,
            permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
            send: jest.fn(async () => ({ id: 'msg-posted', react: jest.fn(async () => {}) })),
        };
        return {
            guild,
            guildId: guild.id,
            channel,
            channelId,
            user: { id: OWNER },
            options: {
                getString: (n) => (n === 'mode' ? mode : n === 'text' ? text : null),
                getRole: () => role,
            },
            reply: jest.fn(async () => {}),
        };
    }

    test('verify posts the message, reacts, and binds it', async () => {
        const guild = makeGuild();
        const i = interaction(guild, { mode: 'verify', role: { id: 'role-member', name: 'member', position: 1, managed: false } });

        await gate.handleGateCommand(i);

        expect(i.channel.send).toHaveBeenCalledWith({ content: expect.stringContaining('**member**'), allowedMentions: { parse: [] } });
        expect(gate.load(guild.id).verify).toMatchObject({ channelId: 'ch-verify', messageId: 'msg-posted', roleId: 'role-member' });
    });

    test('verify refuses a role above the bot, and posts nothing', async () => {
        const guild = makeGuild();
        const i = interaction(guild, { mode: 'verify', role: { id: 'role-top', name: 'mods', position: 9, managed: false } });

        await gate.handleGateCommand(i);

        expect(i.channel.send).not.toHaveBeenCalled();
        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('above my highest role') }));
        expect(gate.load(guild.id).verify).toBeNull();
    });

    test('honeypot binds this channel by id and snapshots the invites', async () => {
        const guild = makeGuild({ invites: [invite('abc', 0)] });
        const i = interaction(guild, { mode: 'honeypot', channelId: HONEYPOT });

        await gate.handleGateCommand(i);

        expect(gate.load(guild.id).honeypot).toMatchObject({ channelId: HONEYPOT, setBy: OWNER });
        expect(reaper.inviteCache.get(guild.id).get('abc')).toBe(0);
    });

    test('off unbinds only what is in this channel', async () => {
        const guild = makeGuild();
        gate.save(guild.id, {
            honeypot: { channelId: HONEYPOT },
            verify: { channelId: 'ch-verify', messageId: 'm', roleId: 'r' },
            joins: {},
        });

        await gate.handleGateCommand(interaction(guild, { mode: 'off', channelId: HONEYPOT }));

        const data = gate.load(guild.id);
        expect(data.honeypot).toBeNull();
        expect(data.verify).not.toBeNull();
    });
});
