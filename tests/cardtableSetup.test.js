/**
 * `/setup cardtable` against a stateful guild: what a fresh guild ends up
 * with, that a second run changes nothing, that a failure unwinds, and that a
 * join through the printed invite earns Player.
 */

jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { ChannelType, OverwriteType, PermissionsBitField } = require('discord.js');
const { createMockLayoutGuild, createMockInteraction } = require('./mocks/discord');
const setup = require('../lib/cardtableSetup');
const store = require('../lib/cardtableStore');
const reaper = require('../lib/meetingSpaceReaper');
const permissions = require('../lib/permissions');

const OWNER = '100000000000000001';

function freshGuild(opts) {
    const guild = createMockLayoutGuild({ id: `guild-${Math.random().toString(36).slice(2)}`, ownerId: OWNER, ...opts });
    guild.addMember(OWNER);
    guild.addMember('bot-user-id', { bot: true });
    return guild;
}

function interactionFor(guild, { userId = OWNER, layout = 'cardtable' } = {}) {
    return createMockInteraction({
        guild,
        guildId: guild.id,
        user: { id: userId },
        options: { getString: jest.fn(() => layout) },
    });
}

afterEach(() => {
    // Bindings are global across guilds (resolveBoundGuild walks them all), so
    // each test starts unbound.
    for (const id of store.listBoundGuildIds()) {
        fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, id, 'cardtable.json'));
    }
});

describe('applyCardtableLayout on a fresh guild', () => {
    let guild;
    let result;

    beforeEach(async () => {
        guild = freshGuild();
        result = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
    });

    test('creates the three categories with their channels in order', () => {
        const byName = (name) => guild.channelNamed(name);
        for (const cat of setup.LAYOUT.categories) {
            const category = guild.channels.cache.find((c) => c.name === cat.name && c.type === ChannelType.GuildCategory);
            expect(category).toBeDefined();
            for (const spec of cat.channels) {
                expect(byName(spec.name).parentId).toBe(category.id);
                expect(byName(spec.name).type).toBe(spec.voice ? ChannelType.GuildVoice : ChannelType.GuildText);
            }
        }
    });

    test("adopts Discord's default #general instead of making a second one", () => {
        const generals = guild.channels.cache.filter((c) => c.name === 'general');
        expect(generals.size).toBe(1);
        expect(guild.channelNamed('general').setParent).toHaveBeenCalledWith(
            result.record.categories.table,
            expect.objectContaining({ lockPermissions: false })
        );
        expect(result.report.untouched).toEqual(expect.arrayContaining(['Text Channels', 'Voice Channels', 'General']));
    });

    test('announcements and events are read-only for @everyone and writable by the bot', () => {
        for (const name of ['announcements', 'events']) {
            const ch = guild.channelNamed(name);
            const everyone = ch.overwrites.get(guild.id);
            expect(everyone).toMatchObject({ SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, _type: OverwriteType.Role });
            expect(ch.overwrites.get('bot-user-id')).toMatchObject({ ViewChannel: true, SendMessages: true, EmbedLinks: true, _type: OverwriteType.Member });
        }
        expect(guild.channelNamed('general').overwrites.size).toBe(0);
    });

    test('creates Player and Admin with no Discord permissions', () => {
        expect(guild.roles.create).toHaveBeenCalledTimes(2);
        for (const call of guild.roles.create.mock.calls) {
            expect(call[0].permissions).toEqual([]);
            expect(call[0].mentionable).toBe(false);
        }
    });

    test('gives the owner Admin and every human Player, but not the bot', async () => {
        const owner = guild.members.list.get(OWNER);
        expect(owner.roles.cache.has(result.record.roles.admin)).toBe(true);
        expect(owner.roles.cache.has(result.record.roles.player)).toBe(true);
        expect(guild.members.list.get('bot-user-id').roles.add).not.toHaveBeenCalled();
    });

    test('mints one permanent, unlimited invite on #general and records its Player binding', () => {
        const general = guild.channelNamed('general');
        expect(general.createInvite).toHaveBeenCalledWith(expect.objectContaining({ maxAge: 0, maxUses: 0 }));
        expect(store.getSetup(guild.id).invite).toEqual({
            code: result.record.invite.code,
            url: `https://discord.gg/${result.record.invite.code}`,
            channelId: general.id,
            roleId: result.record.roles.player,
        });
    });

    test('binds this guild for the webhook routes', () => {
        expect(store.resolveBoundGuild()).toMatchObject({ ok: true, guildId: guild.id });
    });

    test('the report lists the invite URL and every channel', () => {
        const text = setup.formatReport(result);
        expect(text).toContain(result.record.invite.url);
        expect(text).toContain(`<#${result.record.channels.announcements}> read-only (created)`);
        expect(text).toContain(`<#${result.record.channels.general}> (moved here)`);
        expect(text).toContain('Table 1 (created)');
        expect(text).toContain('Player (created) · Admin (created)');
    });
});

describe('re-running', () => {
    test('creates nothing, keeps the invite, and re-applies the read-only overwrites', async () => {
        const guild = freshGuild();
        const first = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        const announcements = guild.channelNamed('announcements');
        // Someone loosened it by hand.
        announcements.overwrites.delete(guild.id);
        guild.roles.create.mockClear();
        guild.channels.create.mockClear();

        const second = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });

        expect(second.createdCount).toBe(0);
        expect(guild.roles.create).not.toHaveBeenCalled();
        expect(guild.channels.create).not.toHaveBeenCalled();
        expect(second.record.invite.code).toBe(first.record.invite.code);
        expect(second.report.invite.state).toBe('existing');
        expect(announcements.overwrites.get(guild.id)).toMatchObject({ SendMessages: false });
    });

    test('follows a renamed channel by its recorded id rather than making a new one', async () => {
        const guild = freshGuild();
        await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        guild.channelNamed('looking-for-game').name = 'lfg';
        guild.channels.create.mockClear();

        await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        expect(guild.channels.create).not.toHaveBeenCalled();
    });

    test('replaces an invite the operator deleted, and the binding follows it', async () => {
        const guild = freshGuild();
        const first = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        (await guild.invites.fetch()).delete(first.record.invite.code);

        const second = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        expect(second.record.invite.code).not.toBe(first.record.invite.code);
        expect(store.findInviteBinding(guild.id, first.record.invite.code)).toBeNull();
        expect(store.findInviteBinding(guild.id, second.record.invite.code)).not.toBeNull();
    });
});

describe('failure', () => {
    test('rolls back everything the run created and writes no binding', async () => {
        const guild = freshGuild();
        const before = new Set(guild.channels.cache.keys());
        guild.failOn((kind, opts) => kind === 'channel' && opts.name === 'Table 2');

        await expect(setup.applyCardtableLayout(guild, { appliedBy: OWNER })).rejects.toThrow('Missing Permissions');

        // Only Discord's defaults remain; #general was adopted, not created, so it stays.
        expect(new Set(guild.channels.cache.keys())).toEqual(before);
        expect(guild.roles.cache.size).toBe(1); // @everyone
        expect(store.getSetup(guild.id)).toBeNull();
    });

    test('refuses a role it cannot hand out, and says how to fix it', async () => {
        const guild = freshGuild();
        const role = await guild.roles.create({ name: 'Player' });
        role.editable = false;
        guild.roles.create.mockClear();

        const interaction = interactionFor(guild);
        await setup.handleSetupCommand(interaction);

        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Drag my role above it') });
        expect(store.getSetup(guild.id)).toBeNull();
    });
});

describe('handleSetupCommand', () => {
    test('defers, applies, and replies with the report', async () => {
        const guild = freshGuild();
        const interaction = interactionFor(guild);
        await setup.handleSetupCommand(interaction);

        expect(interaction.deferReply).toHaveBeenCalled();
        const { content } = interaction.editReply.mock.calls[0][0];
        expect(content).toMatch(/^\*\*cardtable layout applied\*\*/);
        expect(content).toContain(store.getSetup(guild.id).invite.url);
    });

    test('names the missing permissions instead of failing halfway', async () => {
        const guild = freshGuild({ botPermissions: (flag) => flag !== PermissionsBitField.Flags.ManageRoles });
        const interaction = interactionFor(guild);
        await setup.handleSetupCommand(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ManageRoles') }));
        expect(guild.channels.create).not.toHaveBeenCalled();
    });

    test('will not bind a second guild', async () => {
        const first = freshGuild();
        await setup.applyCardtableLayout(first, { appliedBy: OWNER });

        const second = freshGuild();
        const interaction = interactionFor(second);
        await setup.handleSetupCommand(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already set up in another server') }));
        expect(second.channels.create).not.toHaveBeenCalled();
        expect(store.resolveBoundGuild()).toMatchObject({ ok: true, guildId: first.id });
    });

    test('rejects an unknown layout', async () => {
        const guild = freshGuild();
        const interaction = interactionFor(guild, { layout: 'other' });
        await setup.handleSetupCommand(interaction);
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Unknown layout: other' }));
    });
});

describe('a join through the cardtable invite', () => {
    test('earns Player', async () => {
        const guild = freshGuild();
        const { record } = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        // The setup refreshed the cache; now someone uses the link.
        (await guild.invites.fetch()).get(record.invite.code).uses = 1;
        const member = guild.addMember('200000000000000002');
        member.guild = guild;

        const bound = await reaper.handleMemberAdd(member);

        expect(bound).toEqual({ roleId: record.roles.player, code: record.invite.code });
        expect(member.roles.add).toHaveBeenCalledWith(record.roles.player, expect.any(String));
    });

    test('a join through some other invite gets nothing', async () => {
        const guild = freshGuild();
        await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        const other = await guild.channelNamed('general').createInvite({ maxAge: 0, maxUses: 0 });
        await reaper.cacheGuildInvites(guild);
        other.uses = 1;
        const member = guild.addMember('200000000000000003');
        member.guild = guild;

        expect(await reaper.handleMemberAdd(member)).toBeNull();
        expect(member.roles.add).not.toHaveBeenCalled();
    });
});

describe('the guild owner is an admin', () => {
    test('before any admin role or permissions entry exists', async () => {
        const guild = freshGuild();
        guild.members.fetch = jest.fn(async () => ({ roles: { cache: { some: () => false } } }));
        await expect(permissions.hasAdminAccess(OWNER, guild)).resolves.toBe(true);
        await expect(permissions.hasAdminAccess('200000000000000009', guild)).resolves.toBe(false);
        // The non-owner lookup initialises Resources/{guildId}/permissions.json,
        // which the permissions module does not route through the test root.
        fs.rmSync(path.join(__dirname, '..', 'Resources', guild.id), { recursive: true, force: true });
    });
});
