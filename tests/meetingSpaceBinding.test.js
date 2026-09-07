/**
 * Invite → role binding, end to end through the cache.
 *
 * The bug this exists for was STRUCTURAL, not a race: provisioning created the
 * invite but never refreshed the invite cache, so the new code was absent from
 * the "before" snapshot. A maxUses:1 invite is consumed and deleted the instant
 * it is used, so it was absent from "after" too — nothing appeared to vanish,
 * every join logged `join_unattributed`, and the guest landed in the guild with
 * no role and no private space. Nothing errored.
 *
 * The previous tests all exercised resolveConsumedCode with hand-built maps, so
 * they proved the DIFF was correct while the thing feeding it was empty. These
 * drive the real path: provision, then join.
 */

const meetingSpace = require('../lib/meetingSpace');
const reaper = require('../lib/meetingSpaceReaper');
const store = require('../lib/meetingSpaceStore');

const GUILD_ID = 'guild-binding-test';
const BOT_ID = 'bot-1';
const NEW_CODE = 'newInvite1';

function makeGuild({ existingInvites = ['old1'], liveAfterJoin = ['old1'] } = {}) {
    let phase = 'before';
    const invites = {
        fetch: jest.fn().mockImplementation(async () => {
            const codes = phase === 'before' ? existingInvites.concat(NEW_CODE) : liveAfterJoin;
            return {
                forEach(fn) {
                    codes.forEach((c) => fn({ code: c, uses: 0 }));
                },
            };
        }),
    };
    return {
        id: GUILD_ID,
        invites,
        roles: {
            everyone: { id: 'everyone' },
            cache: { size: 3 },
            create: jest.fn().mockResolvedValue({ id: 'role-new' }),
        },
        channels: {
            cache: { size: 4 },
            create: jest.fn().mockImplementation(async (opts) => ({
                id: `ch-${opts.name}`,
                createInvite: jest.fn().mockResolvedValue({ code: NEW_CODE, url: 'https://discord.gg/new' }),
            })),
        },
        _join() { phase = 'after'; },
    };
}

const client = (guild) => ({ user: { id: BOT_ID }, guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: jest.fn() } });

describe('a guest who uses a space invite gets the space role', () => {
    let guild;

    beforeEach(async () => {
        reaper.inviteCache.clear();
        store.save(GUILD_ID, { spaces: [] });
        guild = makeGuild();

        await meetingSpace.handleSpaceProvision(
            { idempotencyKey: 'bind-1', timestamp: Date.now(), label: 'l', guild_id: GUILD_ID, source: 'test' },
            client(guild)
        );
    });

    // The assertion that would have caught the bug at the source.
    it('puts the new invite into the cache at provision time', () => {
        const snapshot = reaper.inviteCache.get(GUILD_ID);
        expect(snapshot).toBeDefined();
        expect(snapshot.has(NEW_CODE)).toBe(true);
    });

    it('assigns the role when that invite is consumed', async () => {
        guild._join(); // the maxUses:1 invite is gone now

        const add = jest.fn().mockResolvedValue();
        const member = { id: 'guest-1', guild, roles: { add } };

        const bound = await reaper.handleMemberAdd(member);

        expect(bound).not.toBeNull();
        expect(add).toHaveBeenCalledWith('role-new', expect.stringContaining('meeting space'));
    });

    it('records the member so the sweep knows who to kick', async () => {
        guild._join();
        await reaper.handleMemberAdd({ id: 'guest-2', guild, roles: { add: jest.fn().mockResolvedValue() } });

        const space = store.load(GUILD_ID).spaces[0];
        expect(space.memberId).toBe('guest-2');
    });

    // Someone arriving through an ordinary server invite must not be swept into
    // a stranger's private space.
    it('leaves a join through an unrelated invite unbound', async () => {
        // 'old1' disappears instead — not a space invite.
        const other = makeGuild({ existingInvites: ['old1'], liveAfterJoin: [NEW_CODE] });
        reaper.inviteCache.set(GUILD_ID, new Map([['old1', 0], [NEW_CODE, 0]]));
        other.id = GUILD_ID;
        other._join();

        const add = jest.fn();
        const bound = await reaper.handleMemberAdd({ id: 'guest-3', guild: other, roles: { add } });

        expect(bound).toBeNull();
        expect(add).not.toHaveBeenCalled();
    });
});
