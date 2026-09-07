/**
 * Persistence for meeting spaces.
 *
 * One JSON file per guild under `Output/{guildId}/spaces.json`, matching the
 * scheduler's layout so a guild's state stays in one directory.
 *
 * Kept SEPARATE from the scheduler's `scheduled.json` deliberately. That file
 * is the announce queue, walked every 60 seconds by a tick that fires items;
 * spaces are long-lived records with a different lifecycle and a different
 * reaper. Sharing the file would mean two writers racing on a store that has
 * no locking, and the scheduler's read-modify-write window is already noted as
 * a soft spot in its own code.
 *
 * A space record:
 *   spaceId         opaque token, also the channel/role name suffix
 *   idempotencyKey  the caller's key — dedupes a replayed provision
 *   label           human description, operator-only, never a Discord name
 *   roleId / categoryId / channelIds / inviteCode / inviteUrl
 *   memberId        set when someone joins through the invite; null until then
 *   createdAt / expiresAt / active
 *   teardownAttempts / stuck
 *                   how many sweeps have failed on it, and whether it has been
 *                   parked as undeletable. `stuck` is NOT `!active` — see
 *                   `markStuck`.
 */

const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');

const SPACES_DIR = path.join(__dirname, '..', 'Output');

function getSpacesFilePath(guildId) {
    return path.join(SPACES_DIR, guildId, 'spaces.json');
}

function ensureGuildDirectory(guildId) {
    const guildPath = path.join(SPACES_DIR, guildId);
    helper.ensureDirectoryExists(guildPath);
    return guildPath;
}

function load(guildId) {
    ensureGuildDirectory(guildId);
    const filePath = getSpacesFilePath(guildId);
    if (!fs.existsSync(filePath)) {
        const initial = { spaces: [], lastUpdated: new Date().toISOString() };
        save(guildId, initial);
        return initial;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // A truncated write (power loss mid-save) must not take the bot down on
        // boot — an unreadable store reads as empty, and the sweep then leaves
        // orphaned channels alone rather than deleting things it cannot verify.
        if (!parsed || !Array.isArray(parsed.spaces)) {
            return { spaces: [], lastUpdated: new Date().toISOString() };
        }
        return parsed;
    } catch {
        return { spaces: [], lastUpdated: new Date().toISOString() };
    }
}

function save(guildId, data) {
    ensureGuildDirectory(guildId);
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(getSpacesFilePath(guildId), JSON.stringify(data, null, 2));
}

function upsert(guildId, record) {
    const data = load(guildId);
    const idx = data.spaces.findIndex((s) => s.spaceId === record.spaceId);
    if (idx >= 0) data.spaces[idx] = record;
    else data.spaces.push(record);
    save(guildId, data);
    return record;
}

function findByIdempotencyKey(guildId, key) {
    return load(guildId).spaces.find((s) => s.idempotencyKey === key) ?? null;
}

function findBySpaceId(guildId, spaceId) {
    return load(guildId).spaces.find((s) => s.spaceId === spaceId) ?? null;
}

function findByInviteCode(guildId, code) {
    return load(guildId).spaces.find((s) => s.inviteCode === code && s.active) ?? null;
}

/**
 * Active, expired spaces the sweep should attempt.
 *
 * `stuck` spaces are excluded deliberately. They are still active and still
 * charge the guild's ceilings — which is exactly why they are not marked
 * inactive — but they have failed teardown enough times that retrying is
 * known-futile. Left in, they fail the sweep every 60 seconds forever, which
 * both flaps the cron and buries the next real stall. `listStuck` surfaces
 * them instead, once, with something an operator can act on.
 */
function findExpired(guildId, now = Date.now()) {
    return load(guildId).spaces.filter(
        (s) => s.active && !s.stuck && Date.parse(s.expiresAt) <= now
    );
}

function markInactive(guildId, spaceId, extra = {}) {
    const data = load(guildId);
    const space = data.spaces.find((s) => s.spaceId === spaceId);
    if (!space) return null;
    space.active = false;
    space.teardownAt = new Date().toISOString();
    // A space that finally tore down is no longer stuck. `stuckAt` is left as
    // the record that it once was, which is the part worth keeping.
    delete space.stuck;
    Object.assign(space, extra);
    save(guildId, data);
    return space;
}

/**
 * Record one failed teardown and return the running count.
 *
 * The count is the whole point: it is what lets the sweep tell a transient
 * Discord 5xx (worth retrying next minute) from a space the bot can never
 * delete (worth parking and telling somebody about).
 */
function recordTeardownFailure(guildId, spaceId, errors = []) {
    const data = load(guildId);
    const space = data.spaces.find((s) => s.spaceId === spaceId);
    if (!space) return null;
    space.teardownAttempts = (space.teardownAttempts ?? 0) + 1;
    space.lastTeardownError = errors.join('; ');
    space.lastTeardownAt = new Date().toISOString();
    save(guildId, data);
    return space;
}

/**
 * Park a space the sweep cannot tear down.
 *
 * NOT the same as inactive, and the difference is load-bearing: an inactive
 * record whose channels are still live is invisible to every future sweep and
 * charges the 500-channel ceiling forever. A stuck record stays active and
 * stays countable — it is only taken out of the 60-second retry loop, after it
 * has announced itself once.
 */
function markStuck(guildId, spaceId, extra = {}) {
    const data = load(guildId);
    const space = data.spaces.find((s) => s.spaceId === spaceId);
    if (!space) return null;
    space.stuck = true;
    space.stuckAt = new Date().toISOString();
    Object.assign(space, extra);
    save(guildId, data);
    return space;
}

/** Spaces parked by `markStuck` — still live in Discord, awaiting an operator. */
function listStuck(guildId) {
    return load(guildId).spaces.filter((s) => s.active && s.stuck);
}

function setMember(guildId, spaceId, memberId) {
    const data = load(guildId);
    const space = data.spaces.find((s) => s.spaceId === spaceId);
    if (!space) return null;
    space.memberId = memberId;
    space.joinedAt = new Date().toISOString();
    save(guildId, data);
    return space;
}

/** Every guild directory that has a spaces.json — the sweep iterates these. */
function listGuildIds() {
    if (!fs.existsSync(SPACES_DIR)) return [];
    return fs
        .readdirSync(SPACES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => fs.existsSync(getSpacesFilePath(name)));
}

module.exports = {
    load,
    save,
    upsert,
    findByIdempotencyKey,
    findBySpaceId,
    findByInviteCode,
    findExpired,
    markInactive,
    recordTeardownFailure,
    markStuck,
    listStuck,
    setMember,
    listGuildIds,
    getSpacesFilePath,
};
