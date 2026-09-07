/**
 * Discord does not cascade.
 *
 * Deleting a category leaves its channels alive and merely uncategorised. This
 * code assumed otherwise — and said so in a comment — so every reaped space
 * left a `chat` and a `Meeting Room` behind. Their records were already marked
 * inactive, so no later sweep looked at them, and each pair charged the
 * 500-channel ceiling permanently. The operator found it by looking at the
 * server, which is the only place it was visible.
 */
const { teardownSpace } = require('../lib/meetingSpaceReaper');

const MISSING_ACCESS = 50001;

function makeGuild({ categoryThrows = null, deleted = [] } = {}) {
    const mk = (id) => ({
        id,
        delete: jest.fn().mockImplementation(async () => {
            if (id === 'cat1' && categoryThrows) throw categoryThrows;
            deleted.push(id);
        }),
    });
    return {
        id: 'g-cascade',
        ownerId: 'owner',
        members: { fetch: jest.fn().mockResolvedValue(null), me: null },
        channels: { fetch: jest.fn().mockImplementation(async (id) => mk(id)) },
        roles: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue() }) },
        _deleted: deleted,
    };
}

const space = (over = {}) => ({
    spaceId: 'tok-cascade',
    categoryId: 'cat1',
    roleId: 'role1',
    channelIds: ['chat1', 'voice1'],
    memberId: null,
    ...over,
});

describe('teardown deletes child channels, not just the category', () => {
    it('deletes chat and Meeting Room explicitly', async () => {
        const deleted = [];
        const guild = makeGuild({ deleted });
        const out = await teardownSpace(guild, space());

        expect(out.deleted).toBe(true);
        // The assertion the missing-cascade bug would fail.
        expect(deleted).toContain('chat1');
        expect(deleted).toContain('voice1');
        expect(deleted).toContain('cat1');
    });

    it('deletes the children BEFORE the category', async () => {
        const deleted = [];
        const guild = makeGuild({ deleted });
        await teardownSpace(guild, space());
        expect(deleted.indexOf('chat1')).toBeLessThan(deleted.indexOf('cat1'));
    });

    it('still works for a legacy record with no channelIds', async () => {
        const deleted = [];
        const guild = makeGuild({ deleted });
        const out = await teardownSpace(guild, space({ channelIds: undefined }));
        expect(out.deleted).toBe(true);
        expect(deleted).toContain('cat1');
    });
});
