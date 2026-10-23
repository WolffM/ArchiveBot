/**
 * `/setup cardtable` — converge a guild onto the cardtable layout.
 *
 * The operator creates the guild by hand (bots cannot create guilds) and
 * invites the bot. Everything after that is this command: categories,
 * channels, roles, a permanent invite bound to Player, and the binding that
 * tells the webhook routes which guild a cardtable-signed request belongs to.
 * The layout is hadoku-cardtable/docs/planning/discord-integration.md §2.
 *
 * ## Idempotent by convergence
 *
 * Each piece is found before it is made: by the id recorded on the last
 * successful run first (so an operator renaming #general does not get a
 * second one), then by name. A run on a finished guild creates nothing and
 * re-applies the read-only overwrites, so it is also the repair path if
 * someone loosened them by hand.
 *
 * Found-by-name channels are ADOPTED into their category. A fresh guild ships
 * a #general under "Text Channels"; the layout's #general is that one, moved,
 * not a second channel beside it. Nothing outside the layout is deleted — the
 * reply lists it so the operator can tidy up by hand.
 *
 * ## Rollback
 *
 * On a failure, everything THIS run created is deleted again, newest first,
 * and the binding is not written. Adopted channels are not moved back: they
 * existed before and still do, under a better category. The point of the
 * unwind is that a failed run leaves no half-built layout that a later
 * webhook could be routed into.
 */

const {
    ChannelType,
    OverwriteType,
    PermissionsBitField,
    MessageFlags,
} = require('discord.js');
const { createLogger } = require('../utils/logger');
const { mirrorToLedger } = require('./ledger');
const store = require('./cardtableStore');

const log = createLogger('cardtableSetup');

const LAYOUT = {
    roles: [
        { key: 'player', name: 'Player', hoist: false },
        // Doubles as the bot-admin marker: permissions.hasAdminAccess treats a
        // role named "admin" as admin, so whoever holds it can run /setup.
        { key: 'admin', name: 'Admin', hoist: true },
    ],
    categories: [
        {
            key: 'info',
            name: 'Info',
            channels: [
                { key: 'announcements', name: 'announcements', readOnly: true, topic: 'Patch notes, posted on every release.' },
                { key: 'events', name: 'events', readOnly: true, topic: 'Tournaments and draft nights. The events themselves are in the Events tab.' },
            ],
        },
        {
            key: 'table',
            name: 'Table',
            channels: [
                { key: 'general', name: 'general' },
                { key: 'lookingForGame', name: 'looking-for-game', topic: 'Anyone up for a draft?' },
                { key: 'bugsAndFeedback', name: 'bugs-and-feedback', topic: 'Playtest reports and bugs.' },
            ],
        },
        {
            key: 'voice',
            name: 'Voice',
            channels: [
                { key: 'table1', name: 'Table 1', voice: true },
                { key: 'table2', name: 'Table 2', voice: true },
            ],
        },
    ],
    invite: { channel: 'general', role: 'player' },
};

/** What the bot needs at guild level to apply the layout. */
const REQUIRED_PERMISSIONS = [
    ['ManageChannels', PermissionsBitField.Flags.ManageChannels],
    ['ManageRoles', PermissionsBitField.Flags.ManageRoles],
    ['CreateInstantInvite', PermissionsBitField.Flags.CreateInstantInvite],
    // Reading the guild's invite list, which both the reuse check below and
    // the invite→role binding depend on.
    ['ManageGuild', PermissionsBitField.Flags.ManageGuild],
    ['ViewChannel', PermissionsBitField.Flags.ViewChannel],
    ['SendMessages', PermissionsBitField.Flags.SendMessages],
    // The bot allows itself this on the read-only channels, and Discord
    // refuses an overwrite granting a permission the setter does not hold.
    ['EmbedLinks', PermissionsBitField.Flags.EmbedLinks],
];

// Denied to @everyone on a read-only channel. Thread creation is denied too:
// without it a read-only channel still accepts replies, as threads.
const READ_ONLY_DENY = {
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
};
const READ_ONLY_BOT_ALLOW = { ViewChannel: true, SendMessages: true, EmbedLinks: true };

/** Guilds with a run in flight. Two concurrent runs would both create. */
const running = new Set();

function sameName(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

function missingPermissions(me) {
    return REQUIRED_PERMISSIONS.filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
}

/**
 * Apply the layout. Returns a report for the reply; throws only after
 * rolling back what it created.
 */
async function applyCardtableLayout(guild, { appliedBy }) {
    const previous = store.getSetup(guild.id);
    const me = guild.members.me || (await guild.members.fetchMe());
    const created = [];
    const report = { roles: [], categories: [], members: null, invite: null, untouched: [] };

    const record = {
        appliedAt: new Date().toISOString(),
        appliedBy,
        categories: {},
        channels: {},
        roles: {},
        invite: null,
    };

    try {
        await guild.channels.fetch();
        await guild.roles.fetch();

        for (const spec of LAYOUT.roles) {
            const recordedId = previous?.roles?.[spec.key];
            let role =
                (recordedId && guild.roles.cache.get(recordedId)) ||
                guild.roles.cache.find((r) => !r.managed && sameName(r.name, spec.name));
            let state = 'existing';
            if (!role) {
                role = await guild.roles.create({
                    name: spec.name,
                    hoist: spec.hoist,
                    mentionable: false,
                    // Explicitly nothing. A role created over the API otherwise
                    // starts with @everyone's permissions, which is not a grant
                    // anyone decided on.
                    permissions: [],
                    reason: 'cardtable setup',
                });
                created.push(role);
                state = 'created';
            }
            if (!role.editable) {
                throw new SetupRefusal(
                    `The **${role.name}** role sits above my own role, so I cannot hand it out. ` +
                        `Drag my role above it in Server Settings → Roles and run this again.`
                );
            }
            record.roles[spec.key] = role.id;
            report.roles.push({ name: role.name, state });
        }

        for (const catSpec of LAYOUT.categories) {
            const recordedId = previous?.categories?.[catSpec.key];
            let category =
                (recordedId && guild.channels.cache.get(recordedId)) ||
                guild.channels.cache.find(
                    (c) => c.type === ChannelType.GuildCategory && sameName(c.name, catSpec.name)
                );
            let catState = 'existing';
            if (!category) {
                category = await guild.channels.create({
                    name: catSpec.name,
                    type: ChannelType.GuildCategory,
                    reason: 'cardtable setup',
                });
                created.push(category);
                catState = 'created';
            }
            record.categories[catSpec.key] = category.id;

            const channels = [];
            for (const spec of catSpec.channels) {
                const type = spec.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
                const recordedChannelId = previous?.channels?.[spec.key];
                let channel =
                    (recordedChannelId && guild.channels.cache.get(recordedChannelId)) ||
                    guild.channels.cache.find((c) => c.type === type && sameName(c.name, spec.name));
                let state = 'existing';
                if (!channel) {
                    channel = await guild.channels.create({
                        name: spec.name,
                        type,
                        parent: category.id,
                        ...(spec.topic ? { topic: spec.topic } : {}),
                        reason: 'cardtable setup',
                    });
                    created.push(channel);
                    state = 'created';
                } else if (channel.parentId !== category.id) {
                    // lockPermissions false: an adopted channel keeps its own
                    // overwrites rather than silently taking the category's.
                    await channel.setParent(category.id, { lockPermissions: false, reason: 'cardtable setup' });
                    state = 'moved';
                }
                if (spec.readOnly) {
                    await channel.permissionOverwrites.edit(guild.roles.everyone.id, READ_ONLY_DENY, {
                        type: OverwriteType.Role,
                        reason: 'cardtable setup: read-only',
                    });
                    await channel.permissionOverwrites.edit(me.id, READ_ONLY_BOT_ALLOW, {
                        type: OverwriteType.Member,
                        reason: 'cardtable setup: the bot posts here',
                    });
                }
                record.channels[spec.key] = channel.id;
                channels.push({ id: channel.id, name: spec.name, voice: !!spec.voice, readOnly: !!spec.readOnly, state });
            }
            report.categories.push({ name: category.name, state: catState, channels });
        }

        const inviteRoleId = record.roles[LAYOUT.invite.role];
        const inviteChannelId = record.channels[LAYOUT.invite.channel];
        const live = await guild.invites.fetch();
        const kept = previous?.invite && live.find((inv) => inv.code === previous.invite.code);
        let invite;
        if (kept) {
            invite = kept;
            report.invite = { url: kept.url, state: 'existing' };
        } else {
            const channel = guild.channels.cache.get(inviteChannelId) || (await guild.channels.fetch(inviteChannelId));
            // Permanent and unlimited: this link goes in cardtable's top bar.
            // The binding attributes joins by use-count increase, which works
            // for a reusable invite; see meetingSpaceReaper.resolveConsumedCode.
            invite = await channel.createInvite({
                maxAge: 0,
                maxUses: 0,
                unique: true,
                reason: 'cardtable setup: joins get Player',
            });
            created.push(invite);
            report.invite = { url: invite.url, state: 'created' };
        }
        record.invite = { code: invite.code, url: invite.url, channelId: inviteChannelId, roleId: inviteRoleId };

        // Members already here never pass through the invite, so they are
        // given Player now. Admin goes to the owner — the operator.
        const members = await guild.members.fetch();
        let playersAdded = 0;
        for (const member of members.values()) {
            if (member.user?.bot) continue;
            if (!member.roles.cache.has(record.roles.player)) {
                await member.roles.add(record.roles.player, 'cardtable setup');
                playersAdded += 1;
            }
            if (member.id === guild.ownerId && !member.roles.cache.has(record.roles.admin)) {
                await member.roles.add(record.roles.admin, 'cardtable setup: guild owner');
            }
        }
        report.members = { playersAdded };

        const layoutIds = new Set([...Object.values(record.categories), ...Object.values(record.channels)]);
        report.untouched = [...guild.channels.cache.values()]
            .filter((c) => !layoutIds.has(c.id) && !c.isThread?.())
            .map((c) => c.name);
    } catch (err) {
        err.leftBehind = await rollback(created);
        throw err;
    }

    store.saveSetup(guild.id, record);
    // Awaited for the same reason meetingSpace awaits it: the binding diffs
    // against this snapshot, and the invite URL is usable the moment it is
    // printed.
    await require('./meetingSpaceReaper').cacheGuildInvites(guild);

    return { record, report, createdCount: created.length };
}

/**
 * Delete this run's creations, newest first. Returns the names of whatever
 * could not be deleted, so the reply can say so instead of claiming a clean
 * unwind.
 */
async function rollback(created) {
    const leftBehind = [];
    for (const thing of [...created].reverse()) {
        try {
            await thing.delete('cardtable setup rollback');
        } catch (err) {
            log.warn('rollback_delete_failed', { id: thing.id ?? thing.code, error: err.message });
            leftBehind.push(thing.name ?? thing.url ?? thing.id);
        }
    }
    return leftBehind;
}

/** A refusal the operator can act on; its message is shown to them verbatim. */
class SetupRefusal extends Error {}

function formatReport({ report, createdCount }) {
    const stateWord = { created: 'created', existing: 'in place', moved: 'moved here' };
    const lines = [`**cardtable layout applied** — ${createdCount} created, the rest already in place.`];
    lines.push(`Roles: ${report.roles.map((r) => `${r.name} (${stateWord[r.state]})`).join(' · ')}`);
    for (const cat of report.categories) {
        const channels = cat.channels
            .map((c) => {
                const label = c.voice ? c.name : `<#${c.id}>`;
                return `${label}${c.readOnly ? ' read-only' : ''} (${stateWord[c.state]})`;
            })
            .join(' · ');
        lines.push(`${cat.name}: ${channels}`);
    }
    lines.push(`Members: Player given to ${report.members.playersAdded}; Admin is the server owner.`);
    lines.push(`Invite, permanent, joins get Player (${stateWord[report.invite.state]}): ${report.invite.url}`);
    if (report.untouched.length) {
        lines.push(`Not part of the layout, left alone: ${report.untouched.join(', ')}`);
    }
    return lines.join('\n');
}

async function handleSetupCommand(interaction) {
    const layout = interaction.options.getString('layout');
    const guild = interaction.guild;
    if (layout !== 'cardtable') {
        log.fail('setup_unknown_layout', { guildId: guild.id, layout });
        await interaction.reply({ content: `Unknown layout: ${layout}`, flags: MessageFlags.Ephemeral });
        return;
    }

    const other = store.listBoundGuildIds().filter((id) => id !== guild.id);
    if (other.length) {
        log.fail('setup_already_bound_elsewhere', { guildId: guild.id, boundGuildId: other[0] });
        await interaction.reply({
            content:
                `cardtable is already set up in another server (${other[0]}). Webhooks route to exactly ` +
                `one server, so I won't bind a second. Remove Output/${other[0]}/cardtable.json first if ` +
                `this one should replace it.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const me = guild.members.me || (await guild.members.fetchMe());
    const missing = missingPermissions(me);
    if (missing.length) {
        log.fail('setup_missing_permissions', { guildId: guild.id, missing: missing.join(',') });
        await interaction.reply({
            content: `I'm missing these server permissions: ${missing.join(', ')}. Grant them to my role and run this again.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (running.has(guild.id)) {
        log.fail('setup_already_running', { guildId: guild.id });
        await interaction.reply({ content: 'Setup is already running in this server.', flags: MessageFlags.Ephemeral });
        return;
    }

    running.add(guild.id);
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await applyCardtableLayout(guild, { appliedBy: interaction.user.id });
        mirrorToLedger('archivebot.cardtable', 'cardtable layout applied', {
            guildId: guild.id,
            created: result.createdCount,
        });
        log.success('setup_applied', { guildId: guild.id, created: result.createdCount, invite: result.record.invite.code });
        await interaction.editReply({ content: formatReport(result) });
    } catch (err) {
        if (err instanceof SetupRefusal) {
            log.fail('setup_refused', { guildId: guild.id, reason: err.message });
            await interaction.editReply({ content: err.message });
            return;
        }
        log.error('setup_failed', err, { guildId: guild.id, leftBehind: (err.leftBehind ?? []).join(',') });
        const leftover = err.leftBehind?.length
            ? ` The rollback could not delete: ${err.leftBehind.join(', ')}. Remove them by hand.`
            : ' Everything this run created was deleted again.';
        await interaction.editReply({ content: `Setup failed: ${err.message}.${leftover}` });
    } finally {
        running.delete(guild.id);
    }
}

module.exports = {
    LAYOUT,
    REQUIRED_PERMISSIONS,
    READ_ONLY_DENY,
    READ_ONLY_BOT_ALLOW,
    applyCardtableLayout,
    handleSetupCommand,
    formatReport,
};
