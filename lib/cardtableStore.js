/**
 * Persistence for the cardtable guild binding.
 *
 * One JSON file per guild under `Output/{guildId}/cardtable.json`, beside the
 * scheduler's and the meeting spaces' files so a guild's state stays in one
 * directory.
 *
 * Shape:
 *   setup   null until `/setup cardtable` succeeds in this guild, then:
 *     appliedAt / appliedBy
 *     categories  { info, table, voice }            → channel ids
 *     channels    { announcements, events, general, lookingForGame,
 *                   bugsAndFeedback, table1, table2 } → channel ids
 *     roles       { player, admin }                 → role ids
 *     invite      { code, url, channelId, roleId }
 *   links   reserved for Discord ↔ hadoku identity linking (`/link <code>`),
 *           keyed by Discord user id: { [discordUserId]: { hadokuUserId,
 *           linkedAt } }. Nothing writes it yet. It lives here, per guild,
 *           because a link is "this Discord member is this hadoku user IN the
 *           cardtable guild" — the same person in another guild is not linked.
 *
 * The file with a non-null `setup` IS the binding: the HTTP routes scope a
 * cardtable-signed request to that guild (see webhookServer.js). There is no
 * env var for it on purpose. The guild id is only known after the operator
 * creates the guild by hand, and a vault key that has to be added after that
 * is one more step that can be forgotten; running the setup command is the
 * step that cannot be.
 */

const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');

const { OUTPUT_ROOT: OUTPUT_DIR } = require('./paths');

const FILE_NAME = 'cardtable.json';

function filePath(guildId) {
    return path.join(OUTPUT_DIR, guildId, FILE_NAME);
}

function load(guildId) {
    const p = filePath(guildId);
    if (!fs.existsSync(p)) return { setup: null, links: {} };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { setup: data.setup ?? null, links: data.links ?? {} };
}

function save(guildId, data) {
    helper.ensureDirectoryExists(path.join(OUTPUT_DIR, guildId));
    fs.writeFileSync(
        filePath(guildId),
        JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2)
    );
}

function getSetup(guildId) {
    return load(guildId).setup;
}

function saveSetup(guildId, setup) {
    const data = load(guildId);
    data.setup = setup;
    save(guildId, data);
}

/** Every guild that has completed `/setup cardtable`. */
function listBoundGuildIds() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs
        .readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(filePath(d.name)))
        .map((d) => d.name)
        .filter((guildId) => getSetup(guildId) !== null);
}

/**
 * The cardtable guild, or why there is not exactly one.
 *
 * Two bound guilds is refused rather than resolved by picking one: the setup
 * command already refuses to bind a second, so reaching it means someone edited
 * the files, and posting patch notes into whichever guild sorts first is the
 * silent-misroute this guard exists to prevent.
 */
function resolveBoundGuild() {
    const ids = listBoundGuildIds();
    if (ids.length === 0) return { ok: false, error: 'cardtable_guild_not_set_up' };
    if (ids.length > 1) return { ok: false, error: 'cardtable_guild_ambiguous', guildIds: ids };
    return { ok: true, guildId: ids[0], setup: getSetup(ids[0]) };
}

/** The role a join through this invite earns, or null if it is not ours. */
function findInviteBinding(guildId, code) {
    const invite = getSetup(guildId)?.invite;
    if (!invite || invite.code !== code) return null;
    return { roleId: invite.roleId, code };
}

module.exports = {
    load,
    getSetup,
    saveSetup,
    listBoundGuildIds,
    resolveBoundGuild,
    findInviteBinding,
};
