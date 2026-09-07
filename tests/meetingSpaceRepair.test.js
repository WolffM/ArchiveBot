/**
 * Repair must never touch a LIVE space.
 *
 * On 2026-09-07 this loop walked every record, active included. It deleted a
 * confirmed booking's category, channels and role, and invalidated the invite
 * the guest had already been sent — while reporting success. Expiry belongs to
 * the sweep, which has a clock; repair exists only to collect what a PAST
 * teardown left behind.
 */
const { repairOrphanedSpaces } = require('../lib/meetingSpaceReaper');
const store = require('../lib/meetingSpaceStore');

const GUILD_ID = 'guild-repair-test';

function guildWith(deleted) {
    const mk = (id) => ({ id, delete: jest.fn().mockImplementation(async () => { deleted.push(id); }) });
    return {
        id: GUILD_ID,
        channels: { fetch: jest.fn().mockImplementation(async (id) => mk(id)) },
        roles: { fetch: jest.fn().mockImplementation(async (id) => mk(id)) },
    };
}

const client = (guild) => ({ guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: jest.fn() } });

const rec = (id, active) => ({
    spaceId: id,
    idempotencyKey: `k-${id}`,
    guildId: GUILD_ID,
    categoryId: `cat-${id}`,
    roleId: `role-${id}`,
    channelIds: [`chat-${id}`, `voice-${id}`],
    active,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
});

describe('repairOrphanedSpaces', () => {
    beforeEach(() => {
        store.save(GUILD_ID, { spaces: [rec('dead1', false), rec('live1', true)] });
    });

    it('collects a torn-down space', async () => {
        const deleted = [];
        await repairOrphanedSpaces(client(guildWith(deleted)));
        expect(deleted).toEqual(expect.arrayContaining(['chat-dead1', 'voice-dead1', 'cat-dead1', 'role-dead1']));
    });

    // The regression. A live space belongs to a booking that has not happened.
    it('NEVER touches an active space', async () => {
        const deleted = [];
        const summary = await repairOrphanedSpaces(client(guildWith(deleted)));

        expect(deleted).not.toContain('cat-live1');
        expect(deleted).not.toContain('role-live1');
        expect(deleted).not.toContain('chat-live1');
        expect(summary.skippedActive).toBe(1);
    });

    it('leaves an active record active — it must not be silently retired', async () => {
        await repairOrphanedSpaces(client(guildWith([])));
        const live = store.load(GUILD_ID).spaces.find((s) => s.spaceId === 'live1');
        expect(live.active).toBe(true);
    });
});
