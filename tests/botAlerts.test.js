/**
 * Alerts in Discord: where one goes (#bot-alerts, else the owner's DMs), the
 * hourly throttle per guild and kind, the permission check that feeds it, and
 * that none of it can throw into the caller.
 */

jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');
const { mirrorFailureToLedger } = require('../lib/ledger');
const store = require('../lib/cardtableStore');
const botAlerts = require('../lib/botAlerts');
const { BOT_PERMISSIONS, permissionBits } = require('../lib/botPermissions');

const APP_ID = '1313904906150744074';
const STAMPS = path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, 'bot-alerts.json');
const ALL = BOT_PERMISSIONS.map((p) => p.name);

let seq = 0;

function textChannel(name, { send } = {}) {
    return {
        id: `ch-${++seq}`,
        name,
        isThread: () => false,
        send: send ?? jest.fn(async () => ({})),
    };
}

/**
 * A guild with the channels given, an owner who can be DMed, and a bot
 * member holding `granted`.
 */
function makeGuild({ channels = [], granted = ALL, ownerSend } = {}) {
    const id = `guild-${++seq}`;
    const flags = new Set(granted.map((n) => PermissionsBitField.Flags[n]));
    const owner = { id: `owner-${seq}`, send: ownerSend ?? jest.fn(async () => ({})) };
    const cache = new Map(channels.map((c) => [c.id, c]));
    cache.find = (fn) => [...cache.values()].find(fn);
    return {
        id,
        ownerId: owner.id,
        owner,
        channels: { cache },
        members: { me: { permissions: { has: (flag) => flags.has(flag) } } },
        fetchOwner: jest.fn(async () => owner),
    };
}

function useGuilds(...guilds) {
    const byId = new Map(guilds.map((g) => [g.id, g]));
    botAlerts.init({
        application: { id: APP_ID },
        guilds: {
            cache: byId,
            fetch: jest.fn(async (id) => {
                if (!byId.has(id)) throw Object.assign(new Error('Unknown Guild'), { code: 10004 });
                return byId.get(id);
            }),
        },
    });
}

function bind(guild, botAlertsChannel) {
    store.saveSetup(guild.id, { channels: botAlertsChannel ? { botAlerts: botAlertsChannel.id } : {} });
}

const missingPermissionsError = () => Object.assign(new Error('Missing Permissions'), { code: 50013 });

beforeEach(() => {
    fs.rmSync(STAMPS, { force: true });
    mirrorFailureToLedger.mockClear();
    delete process.env.CLIENT_ID;
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const id of store.listBoundGuildIds()) {
        fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, id, 'cardtable.json'));
    }
});

describe('routing', () => {
    test("goes to the #bot-alerts /setup recorded, even renamed", async () => {
        const channel = textChannel('alerts-renamed');
        const guild = makeGuild({ channels: [channel] });
        bind(guild, channel);
        useGuilds(guild);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'thing failed' })).resolves.toEqual({ sent: true, via: 'channel' });
        expect(channel.send).toHaveBeenCalledWith({ content: expect.stringContaining('**ArchiveBot: thing failed**') });
        expect(guild.owner.send).not.toHaveBeenCalled();
    });

    test('goes to a channel named bot-alerts in a guild /setup never touched', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [textChannel('general'), channel] });
        useGuilds(guild);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'x' })).resolves.toMatchObject({ via: 'channel' });
        expect(channel.send).toHaveBeenCalled();
    });

    test('with no #bot-alerts, DMs the guild owner', async () => {
        const guild = makeGuild({ channels: [textChannel('general')] });
        useGuilds(guild);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'x' })).resolves.toEqual({ sent: true, via: 'dm' });
        expect(guild.owner.send).toHaveBeenCalledWith({ content: expect.stringContaining('**ArchiveBot: x**') });
    });

    test('when #bot-alerts refuses the post, DMs the guild owner', async () => {
        const channel = textChannel('bot-alerts', { send: jest.fn(async () => { throw missingPermissionsError(); }) });
        const guild = makeGuild({ channels: [channel] });
        bind(guild, channel);
        useGuilds(guild);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'x' })).resolves.toEqual({ sent: true, via: 'dm' });
        expect(channel.send).toHaveBeenCalled();
        expect(guild.owner.send).toHaveBeenCalled();
    });

    test('when both refuse, resolves undelivered rather than throwing', async () => {
        const guild = makeGuild({ ownerSend: jest.fn(async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); }) });
        useGuilds(guild);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'x' })).resolves.toEqual({ sent: false, reason: 'no_destination' });
    });

    test('a guild that cannot be resolved resolves as an error, never a rejection', async () => {
        useGuilds();
        await expect(botAlerts.alert({ guildId: 'nope', kind: 'k', what: 'x' })).resolves.toEqual({ sent: false, reason: 'error' });
    });
});

describe('throttle', () => {
    test('the same guild and kind sends once an hour', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [channel] });
        useGuilds(guild);
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

        await expect(botAlerts.alert({ guildId: guild.id, kind: 'retry', what: 'x' })).resolves.toMatchObject({ sent: true });
        now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
        await expect(botAlerts.alert({ guildId: guild.id, kind: 'retry', what: 'x' })).resolves.toEqual({ sent: false, reason: 'throttled' });
        now.mockReturnValue(1_000_000 + botAlerts.THROTTLE_MS);
        await expect(botAlerts.alert({ guildId: guild.id, kind: 'retry', what: 'x' })).resolves.toMatchObject({ sent: true });

        expect(channel.send).toHaveBeenCalledTimes(2);
    });

    test('another kind, or another guild, is not held back', async () => {
        const a = makeGuild({ channels: [textChannel('bot-alerts')] });
        const b = makeGuild({ channels: [textChannel('bot-alerts')] });
        useGuilds(a, b);

        await botAlerts.alert({ guildId: a.id, kind: 'one', what: 'x' });
        await expect(botAlerts.alert({ guildId: a.id, kind: 'two', what: 'x' })).resolves.toMatchObject({ sent: true });
        await expect(botAlerts.alert({ guildId: b.id, kind: 'one', what: 'x' })).resolves.toMatchObject({ sent: true });
    });

    test('survives a restart: the stamp is on disk', async () => {
        const guild = makeGuild({ channels: [textChannel('bot-alerts')] });
        useGuilds(guild);
        await botAlerts.alert({ guildId: guild.id, kind: 'k', what: 'x' });

        let reloaded;
        jest.isolateModules(() => {
            reloaded = require('../lib/botAlerts');
        });
        reloaded.init({ guilds: { cache: new Map([[guild.id, guild]]) } });
        await expect(reloaded.alert({ guildId: guild.id, kind: 'k', what: 'x' })).resolves.toEqual({ sent: false, reason: 'throttled' });
    });
});

describe('reportFailure', () => {
    const create = { name: 'archivebot.event', message: 'event not created' };

    test('keeps the ledger mirror', async () => {
        const guild = makeGuild({ channels: [textChannel('bot-alerts')] });
        useGuilds(guild);
        const context = { source: 'cardtable', guildId: guild.id, error: missingPermissionsError() };

        await botAlerts.reportFailure(create.name, create.message, context);
        expect(mirrorFailureToLedger).toHaveBeenCalledWith(create.name, create.message, context);
    });

    test('a 50013 names what failed, the caller, the error, and the missing permissions with the link', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [channel], granted: ALL.filter((n) => n !== 'CreateEvents' && n !== 'ManageEvents') });
        bind(guild, channel);
        useGuilds(guild);

        await expect(
            botAlerts.reportFailure(create.name, create.message, { source: 'cardtable', guildId: guild.id, error: missingPermissionsError() })
        ).resolves.toMatchObject({ sent: true, via: 'channel' });

        const { content } = channel.send.mock.calls[0][0];
        expect(content.split('\n')).toEqual([
            '**ArchiveBot: event not created**',
            'Caller: cardtable',
            'Discord error: Missing Permissions (50013)',
            expect.stringMatching(/^Fix: grant Create Events, Manage Events\. Re-authorise me here, which adds them to my role: <https:\/\/discord\.com\/oauth2\/authorize\?.*>$/),
        ]);
        expect(content).toContain(`client_id=${APP_ID}`);
        expect(content).toContain(`permissions=${permissionBits()}`);
        expect(content).toContain(`guild_id=${guild.id}`);
    });

    test('a 50013 with every server permission held points at channel overwrites', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [channel] });
        useGuilds(guild);

        await botAlerts.reportFailure('archivebot.message', 'message not delivered', { guildId: guild.id, error: missingPermissionsError() });
        expect(channel.send.mock.calls[0][0].content).toContain("a channel's own permission overwrites are refusing me");
    });

    test('a 10-minute retry loop sends one message an hour', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [channel] });
        useGuilds(guild);
        const now = jest.spyOn(Date, 'now');
        for (let i = 0; i < 6; i++) {
            now.mockReturnValue(5_000_000 + i * 10 * 60 * 1000);
            await botAlerts.reportFailure(create.name, create.message, { guildId: guild.id, error: new Error('boom') });
        }
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(mirrorFailureToLedger).toHaveBeenCalledTimes(6);
    });

    test('without a guild id, it still mirrors and resolves', async () => {
        useGuilds();
        await expect(botAlerts.reportFailure('archivebot.reminder', 'x', {})).resolves.toEqual({ sent: false, reason: 'no_guild' });
        expect(mirrorFailureToLedger).toHaveBeenCalledTimes(1);
    });
});

describe('checkGuildPermissions', () => {
    test('reports exactly what is missing, and posts it in the bound guild', async () => {
        const channel = textChannel('bot-alerts');
        const guild = makeGuild({ channels: [channel], granted: ALL.filter((n) => n !== 'ManageEvents') });
        bind(guild, channel);
        useGuilds(guild);

        const missing = await botAlerts.checkGuildPermissions(guild, { trigger: 'ready' });
        expect(missing.map((p) => p.name)).toEqual(['ManageEvents']);
        const { content } = channel.send.mock.calls[0][0];
        expect(content).toMatch(/^\*\*ArchiveBot: missing server permissions\*\*\nFix: grant Manage Events\. /);
    });

    test('a bound guild with no #bot-alerts yet DMs the owner', async () => {
        const guild = makeGuild({ granted: ALL.filter((n) => n !== 'CreateEvents') });
        bind(guild, null);
        useGuilds(guild);

        await botAlerts.checkGuildPermissions(guild, { trigger: 'ready' });
        expect(guild.owner.send).toHaveBeenCalledWith({ content: expect.stringContaining('Create Events') });
    });

    test('a guild that did not ask for alerts is logged, not messaged', async () => {
        const guild = makeGuild({ channels: [textChannel('general')], granted: ['ViewChannel'] });
        useGuilds(guild);

        const missing = await botAlerts.checkGuildPermissions(guild, { trigger: 'ready' });
        expect(missing).toHaveLength(BOT_PERMISSIONS.length - 1);
        expect(guild.owner.send).not.toHaveBeenCalled();
        expect(fs.existsSync(STAMPS)).toBe(false);
    });

    test('complete permissions send nothing, and clear the stamp so the next shortfall is told at once', async () => {
        const channel = textChannel('bot-alerts');
        const short = makeGuild({ channels: [channel], granted: ALL.filter((n) => n !== 'KickMembers') });
        useGuilds(short);
        await botAlerts.checkGuildPermissions(short, { trigger: 'ready' });
        expect(channel.send).toHaveBeenCalledTimes(1);

        // Re-authorised: the same guild now holds everything.
        short.members.me.permissions.has = () => true;
        await expect(botAlerts.checkGuildPermissions(short, { trigger: 'roleUpdate' })).resolves.toEqual([]);
        expect(channel.send).toHaveBeenCalledTimes(1);

        // Someone takes one away again, within the hour.
        short.members.me.permissions.has = (flag) => flag !== PermissionsBitField.Flags.Speak;
        await botAlerts.checkGuildPermissions(short, { trigger: 'roleUpdate' });
        expect(channel.send).toHaveBeenCalledTimes(2);
        expect(channel.send.mock.calls[1][0].content).toContain('grant Speak.');
    });

    test('a check that cannot read the bot resolves null', async () => {
        const guild = makeGuild();
        guild.members.me = null;
        guild.members.fetchMe = jest.fn(async () => { throw new Error('gateway down'); });
        await expect(botAlerts.checkGuildPermissions(guild, { trigger: 'ready' })).resolves.toBeNull();
    });
});
