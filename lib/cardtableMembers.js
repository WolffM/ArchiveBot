/**
 * Linked members of the cardtable guild: a Discord account linked to a hadoku
 * account (hadoku_site prefs-api, avatars-2026-10-30.md) gets the **Linked**
 * role and a server nickname of its hadoku display name, so who is who on
 * cardtable is readable in the member list.
 *
 *   /api/discord/members/sync  { set: [{ id, name }], remove: [id] }
 *       → { success, applied, absent, failed, removed }
 *
 * prefs-api is the one caller (ARCHIVEBOT_PREFS_WEBHOOK_SECRET): `set` one on a
 * completed link, `remove` one on an unlink, and every linked account in
 * batches from its daily `prefs:avatar-refresh`, which is what carries a
 * rename across and repairs a role someone took off by hand.
 *
 * The links are stored in the guild's cardtable.json (`links`) whether or not
 * the person is in the guild yet: `guildMemberAdd` reads them, so linking first
 * and joining later still ends up Linked. A Discord account linked to two
 * hadoku accounts is one entry, the last one written.
 *
 * ## What is not applied, and why that is not a failure
 *
 * - **The owner's nickname.** Discord lets no bot rename the guild owner.
 * - **A member above the bot's role.** Same rule, any member whose highest
 *   role sits above ours (`member.manageable`). Their role is still added if
 *   Linked itself is below ours.
 * - **The role, when it cannot be had.** A guild set up before Linked existed
 *   gets it on the first sync or linked join (`ensureLinkedRole`): found by
 *   name or created, recorded in the setup, and given to everyone already
 *   linked. `/setup cardtable` is never needed for it, and nothing else in the
 *   guild is touched. A role above the bot's own, or a create Discord refuses,
 *   leaves members without it; nicknames still apply.
 *
 * Each is logged on its own line, never alerted: nobody was owed it.
 *
 * Not replay-guarded: every body is absolute state, so a replay re-applies
 * what was already true, and the daily sync converges any stale replay.
 */

const { createLogger } = require('../utils/logger');
const store = require('./cardtableStore');

const log = createLogger('cardtableMembers');

const MAX_BATCH = 100;
/** Discord's nickname limit. */
const NICKNAME_MAX = 32;
const SNOWFLAKE = /^\d{5,25}$/;
/** Discord's error for a member who is not in the guild. */
const UNKNOWN_MEMBER = 10007;

/** The nickname a hadoku name becomes: trimmed, control characters out, ≤ 32 code points. */
function nicknameFor(name) {
    // eslint-disable-next-line no-control-regex
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return [...clean].slice(0, NICKNAME_MAX).join('').trim();
}

function validEntry(entry) {
    return (
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        SNOWFLAKE.test(entry.id) &&
        typeof entry.name === 'string' &&
        nicknameFor(entry.name) !== ''
    );
}

async function fetchMember(guild, id) {
    try {
        return await guild.members.fetch(id);
    } catch (err) {
        if (err.code === UNKNOWN_MEMBER) return null;
        throw err;
    }
}

/**
 * Give a member the Linked role and their hadoku name. Returns what was done,
 * one word per part, for the log and the tests.
 */
async function applyLink(guild, member, name, roleId) {
    const done = { role: 'skipped', nickname: 'skipped' };
    if (member.user?.bot) return done;
    if (roleId) {
        if (member.roles.cache.has(roleId)) done.role = 'kept';
        else {
            await member.roles.add(roleId, 'cardtable: linked a hadoku account');
            done.role = 'added';
        }
    }
    const nickname = nicknameFor(name);
    if (member.id === guild.ownerId || !member.manageable) {
        done.nickname = 'unmanageable';
        log.info('nickname_not_settable', { guildId: guild.id, memberId: member.id, owner: member.id === guild.ownerId });
    } else if (member.nickname === nickname) {
        done.nickname = 'kept';
    } else {
        await member.setNickname(nickname, 'cardtable: hadoku account name');
        done.nickname = 'set';
    }
    return done;
}

/** Undo `applyLink`. The nickname is cleared only if it is still the one we set. */
async function removeLink(guild, member, name, roleId) {
    if (roleId && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'cardtable: unlinked their hadoku account');
    }
    if (name && member.manageable && member.id !== guild.ownerId && member.nickname === nicknameFor(name)) {
        await member.setNickname(null, 'cardtable: unlinked their hadoku account');
    }
}

/** Guilds whose Linked role is being found or made; two syncs at once must not make two. */
const ensuring = new Map();

/**
 * The guild's Linked role id, made if it has none, or null when it cannot be
 * given out. A role newly recorded here is given to everyone already linked.
 * Writes only `setup.roles.linked`; no channel, category or other role is read
 * or changed.
 */
function ensureLinkedRole(guild) {
    if (!ensuring.has(guild.id)) {
        ensuring.set(
            guild.id,
            findOrCreateLinkedRole(guild).finally(() => ensuring.delete(guild.id))
        );
    }
    return ensuring.get(guild.id);
}

async function findOrCreateLinkedRole(guild) {
    const setup = store.getSetup(guild.id);
    if (!setup) return null;
    const recorded = setup.roles?.linked ?? null;
    let role = recorded ? guild.roles.cache.get(recorded) : null;
    if (!role) {
        try {
            await guild.roles.fetch();
            role =
                (recorded && guild.roles.cache.get(recorded)) ||
                guild.roles.cache.find((r) => !r.managed && r.name.toLowerCase() === 'linked') ||
                (await guild.roles.create({
                    name: 'Linked',
                    hoist: false,
                    mentionable: false,
                    // Explicitly nothing, as /setup's roles: a role made over the
                    // API otherwise starts with @everyone's permissions.
                    permissions: [],
                    reason: 'cardtable: role for linked hadoku accounts',
                }));
        } catch (err) {
            log.warn('linked_role_unavailable', { guildId: guild.id, code: err.code, error: err.message });
            return null;
        }
        store.saveSetup(guild.id, { ...setup, roles: { ...setup.roles, linked: role.id } });
        log.info('linked_role_recorded', { guildId: guild.id, roleId: role.id });
        if (role.editable) await applyAllLinks(guild, role.id);
    }
    if (!role.editable) {
        log.warn('linked_role_not_editable', { guildId: guild.id, hint: "drag the bot's role above Linked" });
        return null;
    }
    return role.id;
}

async function boundGuild(discordClient) {
    const bound = store.resolveBoundGuild();
    if (!bound.ok) return { refusal: { status: 503, body: { success: false, error: bound.error } } };
    const guild = discordClient.guilds.cache.get(bound.guildId) ?? (await discordClient.guilds.fetch(bound.guildId));
    return { guild };
}

async function handleMembersSync(payload, discordClient) {
    const set = payload.set ?? [];
    const remove = payload.remove ?? [];
    if (
        !Array.isArray(set) ||
        !Array.isArray(remove) ||
        set.length + remove.length === 0 ||
        set.length > MAX_BATCH ||
        remove.length > MAX_BATCH ||
        !set.every(validEntry) ||
        !remove.every((id) => typeof id === 'string' && SNOWFLAKE.test(id))
    ) {
        return { status: 400, body: { success: false, error: 'invalid_members' } };
    }
    const { guild, refusal } = await boundGuild(discordClient);
    if (refusal) return refusal;

    const links = store.getLinks(guild.id);
    const result = { applied: 0, absent: 0, failed: 0, removed: 0 };

    const removedNames = new Map(remove.map((id) => [id, links[id]?.name ?? null]));
    for (const id of remove) delete links[id];
    const now = new Date().toISOString();
    for (const { id, name } of set) {
        links[id] = { name, linkedAt: links[id]?.linkedAt ?? now };
    }
    // Stored before anything touches Discord: a member who is absent, or a
    // call Discord refuses, still leaves the link for the join and the next sync.
    store.saveLinks(guild.id, links);
    const roleId = await ensureLinkedRole(guild);

    for (const [id, name] of removedNames) {
        const member = await fetchMember(guild, id);
        if (!member) continue;
        try {
            await removeLink(guild, member, name, roleId);
            result.removed += 1;
        } catch (err) {
            result.failed += 1;
            log.warn('unlink_apply_failed', { guildId: guild.id, memberId: id, code: err.code, error: err.message });
        }
    }

    for (const { id, name } of set) {
        const member = await fetchMember(guild, id);
        if (!member) {
            result.absent += 1;
            continue;
        }
        try {
            await applyLink(guild, member, name, roleId);
            result.applied += 1;
        } catch (err) {
            // 50013 Missing Permissions, a name Discord refuses: the next daily
            // sync tries again, and the link itself is already stored.
            result.failed += 1;
            log.warn('link_apply_failed', { guildId: guild.id, memberId: id, code: err.code, error: err.message });
        }
    }
    log.info('members_synced', { guildId: guild.id, set: set.length, remove: remove.length, ...result });
    return { status: 200, body: { success: true, ...result } };
}

/** `guildMemberAdd`: someone who linked before they joined. */
async function handleLinkedJoin(member) {
    if (!store.getSetup(member.guild.id)) return null;
    const link = store.getLinks(member.guild.id)[member.id];
    if (!link) return null;
    const done = await applyLink(member.guild, member, link.name, await ensureLinkedRole(member.guild));
    log.info('linked_member_joined', { guildId: member.guild.id, memberId: member.id, ...done });
    return done;
}

/** Everyone already linked and in the guild: after `/setup cardtable`, or when Linked is first recorded. */
async function applyAllLinks(guild, roleId) {
    const links = store.getLinks(guild.id);
    let applied = 0;
    for (const [id, { name }] of Object.entries(links)) {
        const member = guild.members.cache?.get(id) ?? (await fetchMember(guild, id));
        if (!member) continue;
        try {
            await applyLink(guild, member, name, roleId);
            applied += 1;
        } catch (err) {
            log.warn('link_apply_failed', { guildId: guild.id, memberId: id, code: err.code, error: err.message });
        }
    }
    return applied;
}

module.exports = { handleMembersSync, handleLinkedJoin, applyAllLinks, applyLink, nicknameFor, NICKNAME_MAX, MAX_BATCH };
