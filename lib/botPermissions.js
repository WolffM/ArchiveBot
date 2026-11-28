'use strict';

/**
 * Every guild permission ArchiveBot's features need, in one place.
 *
 * Each entry names the code that needs it, so the list is checkable against
 * what the bot actually calls rather than against a guess. `/setup` refuses
 * without them, the permission check (`checkGuildPermissions`) compares the
 * bot's real permissions with them, and the invite and re-authorise links
 * carry their bitfield.
 *
 * A bot cannot raise its own permissions: its integration role is managed, and
 * Discord refuses a role edit granting a permission the editor does not hold.
 * Administrator is never on this list. What the bot CAN do is say exactly what
 * is missing and hand over a link that grants it: re-authorising through the
 * OAuth2 URL below sets the bot's managed role to this whole bitfield, so the
 * operator clicks one link instead of editing roles by hand.
 */

const { PermissionsBitField } = require('discord.js');

const BOT_PERMISSIONS = [
    { name: 'ViewChannel', label: 'View Channels', why: 'every feature: a channel the bot cannot see does not exist to it' },
    { name: 'SendMessages', label: 'Send Messages', why: 'reminders, webhook messages, announcements, alerts' },
    { name: 'SendMessagesInThreads', label: 'Send Messages in Threads', why: 'webhook messages to forum posts and threads (eventWebhook.js channel picker)' },
    { name: 'EmbedLinks', label: 'Embed Links', why: "cardtable's embeds; granted to itself on read-only channels" },
    { name: 'AttachFiles', label: 'Attach Files', why: '/colorshow posts an image (colorroles.js)' },
    { name: 'ReadMessageHistory', label: 'Read Message History', why: 'archiving, /api/messages/recent, editing posted messages' },
    { name: 'AddReactions', label: 'Add Reactions', why: 'the scheduler acknowledges with a reaction (scheduler.js), and the verify message (gate.js)' },
    { name: 'MentionEveryone', label: 'Mention @everyone', why: 'reminders and space announcements that ask for @everyone' },
    { name: 'ManageMessages', label: 'Manage Messages', why: "the task list clears others' messages (tasklist.js, messageUtils.js); the honeypot deletes the post (gate.js)" },
    { name: 'ManageChannels', label: 'Manage Channels', why: '/setup layout, meeting spaces' },
    { name: 'ManageRoles', label: 'Manage Roles', why: 'colour roles, admin/task roles, Linked, meeting-space roles, the verify role, channel overwrites' },
    { name: 'ManageNicknames', label: 'Manage Nicknames', why: "a linked member's hadoku name (cardtableMembers.js)" },
    { name: 'ManageGuild', label: 'Manage Server', why: 'reading the invite list: the invite→role binding, and which invite a honeypot poster used' },
    { name: 'CreateInstantInvite', label: 'Create Invite', why: "the cardtable invite, meeting-space invites" },
    { name: 'KickMembers', label: 'Kick Members', why: 'removing guests when a meeting space expires (meetingSpaceReaper.js); the honeypot (gate.js)' },
    // A meeting space's role overwrite grants these, and Discord refuses an
    // overwrite granting a permission the setter does not hold.
    { name: 'Connect', label: 'Connect', why: "granted to a meeting space's role on its voice room" },
    { name: 'Speak', label: 'Speak', why: "granted to a meeting space's role on its voice room" },
    { name: 'CreateEvents', label: 'Create Events', why: 'scheduled events from /schedule and /api/events/create' },
    { name: 'ManageEvents', label: 'Manage Events', why: 'moving and cancelling events (/api/events/update, /schedule remove)' },
];

/** The list's bitfield, as Discord's OAuth2 `permissions` parameter takes it. */
function permissionBits(list = BOT_PERMISSIONS) {
    return list.reduce((bits, p) => bits | PermissionsBitField.Flags[p.name], 0n);
}

/** The entries of the list that `member` does not hold at guild level. */
function missingPermissions(member, list = BOT_PERMISSIONS) {
    return list.filter((p) => !member.permissions.has(PermissionsBitField.Flags[p.name]));
}

function authorizeUrl({ clientId, guildId } = {}) {
    if (!clientId) return null;
    const q = [
        `client_id=${encodeURIComponent(clientId)}`,
        'scope=bot%20applications.commands',
        `permissions=${permissionBits()}`,
        ...(guildId ? [`guild_id=${encodeURIComponent(guildId)}`, 'disable_guild_select=true'] : []),
    ];
    return `https://discord.com/oauth2/authorize?${q.join('&')}`;
}

/** Adding the bot to a new server, with every permission it needs. */
function inviteUrl(clientId) {
    return authorizeUrl({ clientId });
}

/** Re-authorising the bot in a server it is already in: sets its managed role to the full list. */
function reauthorizeUrl(clientId, guildId) {
    return authorizeUrl({ clientId, guildId });
}

module.exports = { BOT_PERMISSIONS, permissionBits, missingPermissions, inviteUrl, reauthorizeUrl };
