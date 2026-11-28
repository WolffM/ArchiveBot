'use strict';

/**
 * A server's front door: a honeypot channel and a verify message.
 *
 *   honeypot  Anyone who posts in it is kicked at once, and the operator gets
 *             an emergency notice (lib/emergency.js) naming the member, the
 *             invite they joined through and who created that invite. Spam
 *             accounts post in every channel they can see; a person reads the
 *             channel's name. Admins are exempt (their post is reported as a
 *             test, not kicked).
 *   verify    A message the bot posts; reacting to it with anything gives the
 *             reactor a role. Un-reacting takes nothing away.
 *
 * Both are bound with `/gate` in the channel itself, by channel id, so renaming
 * the channel changes nothing.
 *
 * State is `Output/{guildId}/gate.json` (synced by lib/stateSync.js):
 *   honeypot  { channelId, setAt, setBy } | null
 *   verify    { channelId, messageId, roleId, setAt, setBy } | null
 *   joins     { [memberId]: { at, code, inviterId, inviterTag, channelId, reason } }
 *             which invite each member joined through, recorded on join in a
 *             guild with a honeypot, because a post can come long after the
 *             join and a restart loses the invite cache. Dropped when the
 *             member leaves, and after JOIN_TTL_MS.
 */

const fs = require('fs');
const path = require('path');
const { escapeMarkdown, MessageFlags, PermissionsBitField } = require('discord.js');
const helper = require('../utils/helper');
const { createLogger } = require('../utils/logger');
const { OUTPUT_ROOT } = require('./paths');
const { mirrorToLedger } = require('./ledger');
const { reportFailure, deliver } = require('./botAlerts');
const { postEmergency } = require('./emergency');
const permissions = require('./permissions');
const { cacheGuildInvites } = require('./meetingSpaceReaper');

const log = createLogger('gate');

const FILE_NAME = 'gate.json';
const JOIN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const EXCERPT_CHARS = 300;
const DEFAULT_VERIFY_TEXT = 'React to this message to get the {role} role and unlock the server.';
const VERIFY_EMOJI = '✅';

function filePath(guildId) {
    return path.join(OUTPUT_ROOT, guildId, FILE_NAME);
}

function load(guildId) {
    const p = filePath(guildId);
    if (!fs.existsSync(p)) return { honeypot: null, verify: null, joins: {} };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { honeypot: data.honeypot ?? null, verify: data.verify ?? null, joins: data.joins ?? {} };
}

function save(guildId, data, now = Date.now()) {
    const joins = Object.fromEntries(
        Object.entries(data.joins).filter(([, j]) => now - Date.parse(j.at) < JOIN_TTL_MS)
    );
    helper.ensureDirectoryExists(path.join(OUTPUT_ROOT, guildId));
    const file = filePath(guildId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, joins }, null, 2));
    fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- joins

/** `guildMemberAdd`: remember which invite this member used. `attribution` is meetingSpaceReaper.attributeJoin's. */
function recordJoin(member, attribution, now = Date.now()) {
    const data = load(member.guild.id);
    if (!data.honeypot) return;
    data.joins[member.id] = {
        at: new Date(now).toISOString(),
        code: attribution.code ?? null,
        inviterId: attribution.inviterId ?? null,
        inviterTag: attribution.inviterTag ?? null,
        channelId: attribution.channelId ?? null,
        reason: attribution.code ? null : attribution.reason ?? null,
    };
    save(member.guild.id, data, now);
    log.info('join_recorded', { guildId: member.guild.id, memberId: member.id, code: attribution.code ?? 'unknown' });
}

/** `guildMemberRemove`. */
function forgetJoin(member) {
    const data = load(member.guild.id);
    if (!data.joins[member.id]) return;
    delete data.joins[member.id];
    save(member.guild.id, data);
}

// ---------------------------------------------------------------- honeypot

function ts(ms) {
    return ms ? `<t:${Math.floor(ms / 1000)}:f> (<t:${Math.floor(ms / 1000)}:R>)` : 'unknown';
}

function inviteLine(join) {
    if (!join) return 'unknown: they joined before the honeypot was set up (or the bot was down)';
    if (!join.code) return `unknown: ${join.reason ?? 'not attributable'}`;
    const by = join.inviterId
        ? `created by **${escapeMarkdown(join.inviterTag ?? 'unknown')}** (<@${join.inviterId}> \`${join.inviterId}\`)`
        : 'creator unknown';
    const where = join.channelId ? ` for <#${join.channelId}>` : '';
    return `\`${join.code}\` ${by}${where}`;
}

function excerpt(message) {
    const text = (message.content || '').replace(/\s+/g, ' ').trim();
    const cut = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
    const files = message.attachments?.size ? ` [+${message.attachments.size} attachment(s)]` : '';
    return cut ? `${escapeMarkdown(cut)}${files}` : `(no text)${files}`;
}

function formatNotice({ message, member, join, outcome }) {
    const user = message.author;
    return [
        `🚨 **Honeypot tripped in ${escapeMarkdown(message.guild.name)}**: <#${message.channelId}>`,
        `**Member:** ${escapeMarkdown(user.tag ?? user.username)} (<@${user.id}> \`${user.id}\`)`,
        `**Account created:** ${ts(user.createdTimestamp)}`,
        `**Joined:** ${ts(member?.joinedTimestamp ?? (join ? Date.parse(join.at) : null))}`,
        `**Invite:** ${inviteLine(join)}`,
        `**Message:** ${excerpt(message)}`,
        `**Action:** ${outcome}`,
    ].join('\n');
}

async function kick(member, message) {
    if (!member) return 'NOT kicked: they are no longer in the server';
    if (!member.kickable) return 'NOT kicked: my role is not above theirs, or I lack Kick Members';
    try {
        await member.kick(`posted in the honeypot channel #${message.channel?.name ?? message.channelId}`);
        return 'kicked';
    } catch (err) {
        log.error('honeypot_kick_failed', err, { guildId: message.guild.id, memberId: member.id });
        return `NOT kicked: ${err.message}`;
    }
}

/**
 * `messageCreate`. Resolves to true when the message was in the honeypot (the
 * caller then does nothing else with it), false otherwise.
 */
async function handleHoneypotMessage(message) {
    if (!message.guild || message.author?.bot || message.webhookId) return false;
    const data = load(message.guild.id);
    if (data.honeypot?.channelId !== message.channelId) return false;

    const guild = message.guild;
    const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    const join = data.joins[message.author.id] ?? null;

    let outcome;
    if (await permissions.hasAdminAccess(message.author.id, guild)) {
        outcome = 'none: they are an admin, so this reads as a test';
    } else {
        try {
            await message.delete();
        } catch (err) {
            log.warn('honeypot_delete_failed', { guildId: guild.id, messageId: message.id, error: err.message });
        }
        outcome = await kick(member, message);
    }

    const content = formatNotice({ message, member, join, outcome });
    log.warn('honeypot_tripped', {
        guildId: guild.id,
        memberId: message.author.id,
        code: join?.code ?? 'unknown',
        inviterId: join?.inviterId ?? 'unknown',
        outcome,
    });
    mirrorToLedger('archivebot.honeypot', 'honeypot tripped', {
        guildId: guild.id,
        memberId: message.author.id,
        inviteCode: join?.code ?? null,
        inviterId: join?.inviterId ?? null,
        outcome,
    });

    if (await postEmergency(content, { source: 'honeypot' })) return true;
    // No emergency channel: the guild's #bot-alerts, else the owner's DMs.
    const via = await deliver(guild, content);
    if (!via) log.error('bot_alert_undelivered', null, { guildId: guild.id, kind: 'honeypot' });
    return true;
}

// ---------------------------------------------------------------- verify

/** `messageReactionAdd`. Resolves to true when the reaction was on the verify message. */
async function handleVerifyReaction(reaction, user) {
    if (user.bot) return false;
    const guildId = reaction.message.guildId;
    if (!guildId) return false;
    const { verify } = load(guildId);
    if (!verify || verify.messageId !== reaction.message.id) return false;

    try {
        const guild = reaction.client.guilds.cache.get(guildId) ?? (await reaction.client.guilds.fetch(guildId));
        const member = await guild.members.fetch(user.id);
        if (member.roles.cache.has(verify.roleId)) return true;
        await member.roles.add(verify.roleId, 'reacted to the verify message');
        log.success('verified', { guildId, memberId: user.id, roleId: verify.roleId });
    } catch (err) {
        log.error('verify_role_failed', err, { guildId, memberId: user.id, roleId: verify.roleId });
        reportFailure('archivebot.verify', 'verify role not given', {
            guildId,
            source: 'verify reaction',
            memberId: user.id,
            error: err,
        });
    }
    return true;
}

// ---------------------------------------------------------------- /gate

function missingChannelPermissions(channel, me, names) {
    const perms = channel.permissionsFor(me);
    return names.filter((n) => !perms?.has(PermissionsBitField.Flags[n]));
}

async function setHoneypot(interaction, data) {
    const { guild, channel } = interaction;
    if (data.verify?.channelId === channel.id) {
        return "This channel holds the verify message. Run `/gate mode:off` here first, or use another channel.";
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const missing = [
        ...(me.permissions.has(PermissionsBitField.Flags.KickMembers) ? [] : ['Kick Members']),
        ...(me.permissions.has(PermissionsBitField.Flags.ManageGuild) ? [] : ['Manage Server (to see which invite was used)']),
        ...missingChannelPermissions(channel, me, ['ViewChannel', 'ManageMessages']),
    ];
    if (missing.length) return `I can't run a honeypot here without: ${missing.join(', ')}.`;

    data.honeypot = { channelId: channel.id, setAt: new Date().toISOString(), setBy: interaction.user.id };
    save(guild.id, data);
    // The snapshot the next join is diffed against.
    await cacheGuildInvites(guild);
    log.success('honeypot_set', { guildId: guild.id, channelId: channel.id });
    return [
        `<#${channel.id}> is now the honeypot. Anyone who posts here is kicked, their message deleted, ` +
            'and you get an emergency notice with the invite they used and who created it.',
        'Admins are not kicked: a post from one is reported as a test.',
        'Invites are tracked from now on, so anyone who joined before this shows as "unknown invite".',
    ].join('\n');
}

async function setVerify(interaction, data) {
    const { guild, channel } = interaction;
    const role = interaction.options.getRole('role');
    if (!role) return 'Pick the role to give: `/gate mode:verify role:@member`.';
    if (data.honeypot?.channelId === channel.id) {
        return "This channel is the honeypot. Run `/gate mode:off` here first, or use another channel.";
    }
    if (role.id === guild.id || role.managed) return `${role.name} can't be given out.`;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return "I can't give roles without Manage Roles.";
    if (role.position >= me.roles.highest.position) {
        return `**${role.name}** is above my highest role, so I can't give it. Drag my role above it in Server Settings → Roles.`;
    }
    const missing = missingChannelPermissions(channel, me, ['ViewChannel', 'SendMessages', 'AddReactions', 'ReadMessageHistory']);
    if (missing.length) return `I can't post the verify message here without: ${missing.join(', ')}.`;

    const text = (interaction.options.getString('text') || DEFAULT_VERIFY_TEXT).replace('{role}', `**${role.name}**`);
    const posted = await channel.send({ content: text, allowedMentions: { parse: [] } });
    await posted.react(VERIFY_EMOJI);

    const replaced = data.verify;
    data.verify = { channelId: channel.id, messageId: posted.id, roleId: role.id, setAt: new Date().toISOString(), setBy: interaction.user.id };
    save(guild.id, data);
    log.success('verify_set', { guildId: guild.id, channelId: channel.id, messageId: posted.id, roleId: role.id });
    return [
        `Posted. Anyone who reacts to it gets **${role.name}**.`,
        ...(replaced ? [`The previous verify message (in <#${replaced.channelId}>) no longer gives a role.`] : []),
    ].join('\n');
}

function clearHere(interaction, data) {
    const here = interaction.channelId;
    const cleared = [];
    if (data.honeypot?.channelId === here) {
        data.honeypot = null;
        data.joins = {};
        cleared.push('honeypot');
    }
    if (data.verify?.channelId === here) {
        data.verify = null;
        cleared.push('verify message');
    }
    if (!cleared.length) return 'Nothing is bound to this channel.';
    save(interaction.guildId, data);
    log.success('gate_cleared', { guildId: interaction.guildId, channelId: here, cleared: cleared.join(',') });
    return `Turned off the ${cleared.join(' and ')} here.`;
}

function status(guildId, data) {
    const lines = [
        data.honeypot ? `Honeypot: <#${data.honeypot.channelId}>` : 'Honeypot: off',
        data.verify
            ? `Verify: https://discord.com/channels/${guildId}/${data.verify.channelId}/${data.verify.messageId} gives <@&${data.verify.roleId}>`
            : 'Verify: off',
        `Emergency channel: ${process.env.ARCHIVEBOT_EMERGENCY_WEBHOOK ? 'configured' : 'NOT configured (notices go to #bot-alerts, else the owner by DM)'}`,
    ];
    return lines.join('\n');
}

async function handleGateCommand(interaction) {
    const mode = interaction.options.getString('mode');
    const data = load(interaction.guildId);
    let reply;
    try {
        if (mode === 'honeypot') reply = await setHoneypot(interaction, data);
        else if (mode === 'verify') reply = await setVerify(interaction, data);
        else if (mode === 'off') reply = clearHere(interaction, data);
        else reply = status(interaction.guildId, data);
    } catch (err) {
        log.error('gate_command', err, { guildId: interaction.guildId, mode });
        reply = `That failed: ${err.message}`;
    }
    await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

module.exports = {
    load,
    save,
    recordJoin,
    forgetJoin,
    formatNotice,
    handleHoneypotMessage,
    handleVerifyReaction,
    handleGateCommand,
    JOIN_TTL_MS,
};
