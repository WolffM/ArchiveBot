/**
 * A space the bot cannot delete must stop failing the sweep forever.
 *
 * Regression test for a live incident: two spaces provisioned before the bot
 * granted itself a ViewChannel overwrite were invisible to it, so every
 * teardown answered `Missing Access`. The sweep returned 500, the cron retried
 * 60 seconds later, and it did that indefinitely — reporting `failed=2`, a
 * count that named neither the spaces nor anything an operator could do.
 *
 * Both halves of that are tested here:
 *
 *   RECOVERY — the guest role can still see the category, and the bot can
 *              still manage the role, so wearing it is a way back in. This is
 *              the fix; parking is only what happens when it fails.
 *   PARKING  — an unrecoverable space is retried a bounded number of times,
 *              alerted once, and excluded from the queue thereafter. It must
 *              NOT be marked inactive: a record whose channels are still live
 *              is invisible to every future sweep and charges the guild's
 *              500-channel ceiling forever.
 */

const path = require('path');
const fs = require('fs');

const store = require('../lib/meetingSpaceStore');
const { teardownSpace, sweepExpiredSpaces } = require('../lib/meetingSpaceReaper');

const GUILD_ID = 'guild-stuck-test';
const BOT_ID = 'bot-user-1';

const missingAccess = () => Object.assign(new Error('Missing Access'), { code: 50001 });

/** An expired space record, as the store holds it. */
const record = (over = {}) => ({
    spaceId: 'stuck1',
    idempotencyKey: 'k-stuck',
    label: 'test',
    source: 'test',
    guildId: GUILD_ID,
    roleId: 'role1',
    categoryId: 'cat1',
    channelIds: ['c1', 'c2'],
    inviteCode: 'inv1',
    memberId: null,
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    active: true,
    ...over,
});

/**
 * A guild whose category delete throws Missing Access until the bot holds the
 * space role — which is exactly how Discord behaves for these records.
 */
function makeGuild({ recoverable, botRoles = new Set() }) {
    const category = {
        id: 'cat1',
        delete: jest.fn(async () => {
            if (!botRoles.has('role1')) throw missingAccess();
        }),
    };
    return {
        id: GUILD_ID,
        ownerId: 'owner-1',
        members: {
            fetch: jest.fn().mockResolvedValue(null),
            me: {
                id: BOT_ID,
                roles: {
                    add: jest.fn(async (roleId) => {
                        if (!recoverable) throw new Error('Missing Permissions');
                        botRoles.add(roleId);
                    }),
                    remove: jest.fn(async (roleId) => botRoles.delete(roleId)),
                },
            },
        },
        channels: { fetch: jest.fn().mockResolvedValue(category) },
        roles: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue() }) },
        _category: category,
    };
}

const client = { guilds: { cache: new Map(), fetch: jest.fn() } };

beforeEach(() => {
    store.save(GUILD_ID, { spaces: [] });
});

afterAll(() => {
    // The store writes a real directory under Output/; take it back out.
    const file = store.getSpacesFilePath(GUILD_ID);
    if (fs.existsSync(file)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe('teardown recovery — wearing the guest role', () => {
    it('deletes a category it cannot see by taking the space role first', async () => {
        const guild = makeGuild({ recoverable: true });
        const out = await teardownSpace(guild, record());

        expect(out.deleted).toBe(true);
        expect(out.recovered).toBe(true);
        expect(guild.members.me.roles.add).toHaveBeenCalledWith('role1', expect.any(String));
    });

    // A bot left holding a guest role can see into somebody's private space.
    it('takes the role back off again even when the delete fails', async () => {
        const botRoles = new Set();
        const guild = makeGuild({ recoverable: true, botRoles });
        guild._category.delete = jest.fn().mockRejectedValue(missingAccess());

        const out = await teardownSpace(guild, record());

        expect(out.deleted).toBe(false);
        expect(guild.members.me.roles.remove).toHaveBeenCalledWith('role1', expect.any(String));
        expect(botRoles.has('role1')).toBe(false);
    });

    it('reports the original error, not the recovery error, when recovery fails', async () => {
        const guild = makeGuild({ recoverable: false });
        const out = await teardownSpace(guild, record());

        expect(out.deleted).toBe(false);
        expect(out.recovered).toBe(false);
        expect(out.errors).toContain('delete_failed:Missing Access');
    });

    // 50013 is "can see it, may not touch it" — a different bug, and wearing a
    // role that grants no MANAGE_CHANNELS would not fix it.
    it('does not attempt recovery for Missing Permissions', async () => {
        const guild = makeGuild({ recoverable: true });
        guild._category.delete = jest
            .fn()
            .mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

        const out = await teardownSpace(guild, record());

        expect(out.deleted).toBe(false);
        expect(guild.members.me.roles.add).not.toHaveBeenCalled();
    });

    // `permanent` is the licence to stop retrying, so it must be issued only to
    // a failure that provably cannot heal.
    it('marks only an unrecoverable Missing Access as permanent', async () => {
        const unrecoverable = await teardownSpace(makeGuild({ recoverable: false }), record());
        expect(unrecoverable.permanent).toBe(true);

        const guild = makeGuild({ recoverable: true });
        guild._category.delete = jest.fn().mockRejectedValue(new Error('Service Unavailable'));
        const transient = await teardownSpace(guild, record());
        expect(transient.deleted).toBe(false);
        expect(transient.permanent).toBe(false);
    });
});

describe('sweep parking — a permanent failure must go quiet', () => {
    const sweep = (guild) => {
        client.guilds.cache = new Map([[GUILD_ID, guild]]);
        return sweepExpiredSpaces(client);
    };

    it('retries a failure rather than parking it on the first miss', async () => {
        store.upsert(GUILD_ID, record());
        const summary = await sweep(makeGuild({ recoverable: false }));

        expect(summary.failed).toBe(1);
        expect(summary.stuck).toBe(0);
        // Still queued, so the next sweep tries again.
        expect(store.findExpired(GUILD_ID)).toHaveLength(1);
    });

    it('parks the space after three failed sweeps and stops retrying it', async () => {
        store.upsert(GUILD_ID, record());

        let summary;
        for (let i = 0; i < 3; i++) summary = await sweep(makeGuild({ recoverable: false }));

        expect(summary.stuck).toBe(1);
        expect(summary.failed).toBe(0);
        expect(store.findExpired(GUILD_ID)).toHaveLength(0);
    });

    // The daily job runs three attempts about three minutes apart, so a short
    // Discord outage can span all of them. Parking on the count alone would
    // silence an alarm for a space that was going to heal by itself.
    it('never parks a transient failure, however often it recurs', async () => {
        store.upsert(GUILD_ID, record());

        const flaky = () => {
            const guild = makeGuild({ recoverable: true });
            guild._category.delete = jest.fn().mockRejectedValue(new Error('Service Unavailable'));
            return guild;
        };

        let summary;
        for (let i = 0; i < 6; i++) summary = await sweep(flaky());

        expect(summary.stuck).toBe(0);
        expect(summary.failed).toBe(1);
        // Still queued and still failing the job, which is the point.
        expect(store.findExpired(GUILD_ID)).toHaveLength(1);
        expect(store.findBySpaceId(GUILD_ID, 'stuck1').teardownAttempts).toBe(6);
    });

    // The whole reason `stuck` is not `!active`: an inactive record with live
    // channels is invisible to every future sweep and charges the ceiling.
    it('keeps a parked space active, so it still counts against the ceiling', async () => {
        store.upsert(GUILD_ID, record());
        for (let i = 0; i < 3; i++) await sweep(makeGuild({ recoverable: false }));

        const parked = store.findBySpaceId(GUILD_ID, 'stuck1');
        expect(parked.stuck).toBe(true);
        expect(parked.active).toBe(true);
        expect(parked.teardownAt).toBeUndefined();
    });

    it('names the channel, the role and the remedy rather than only a count', async () => {
        store.upsert(GUILD_ID, record());
        let summary;
        for (let i = 0; i < 3; i++) summary = await sweep(makeGuild({ recoverable: false }));

        const [item] = summary.attention;
        expect(item.spaceId).toBe('stuck1');
        expect(item.categoryId).toBe('cat1');
        expect(item.roleId).toBe('role1');
        expect(item.action).toMatch(/cat1/);
        expect(item.action).toMatch(/role1/);
        expect(item.action).toMatch(/revoke/);
    });

    // The bug this whole change is about: the endpoint failing every 60s.
    it('keeps reporting a parked space without failing the sweep again', async () => {
        store.upsert(GUILD_ID, record());
        for (let i = 0; i < 3; i++) await sweep(makeGuild({ recoverable: false }));

        const later = await sweep(makeGuild({ recoverable: false }));
        expect(later.failed).toBe(0);
        expect(later.stuck).toBe(1);
        expect(later.attention[0].spaceId).toBe('stuck1');
    });

    it('recovers instead of parking when the role gets it back in', async () => {
        store.upsert(GUILD_ID, record());
        const summary = await sweep(makeGuild({ recoverable: true }));

        expect(summary.swept).toBe(1);
        expect(summary.stuck).toBe(0);
        expect(store.findBySpaceId(GUILD_ID, 'stuck1').active).toBe(false);
    });

    it('clears the stuck flag if a parked space is later torn down', async () => {
        store.upsert(GUILD_ID, record());
        for (let i = 0; i < 3; i++) await sweep(makeGuild({ recoverable: false }));
        expect(store.findBySpaceId(GUILD_ID, 'stuck1').stuck).toBe(true);

        // An operator deletes the channels by hand and calls revoke; teardown
        // then succeeds and marks it inactive.
        await teardownSpace(makeGuild({ recoverable: true }), store.findBySpaceId(GUILD_ID, 'stuck1'));
        store.markInactive(GUILD_ID, 'stuck1', { teardownErrors: [] });

        const done = store.findBySpaceId(GUILD_ID, 'stuck1');
        expect(done.stuck).toBeUndefined();
        expect(store.listStuck(GUILD_ID)).toHaveLength(0);
    });
});
