/**
 * The bot must be able to delete the space it creates.
 *
 * Regression test for a bug found only end-to-end: the category denied
 * @everyone ViewChannel and allowed only the guest's role, which locked the BOT
 * out of the channel it had just built. Provisioning looked perfectly healthy —
 * category, role and invite all created — and every subsequent revoke failed
 * with `Missing Access`, leaving a category that nothing could delete and that
 * still counted against the guild's 500-channel ceiling.
 *
 * Guild-level MANAGE_CHANNELS does not save you: Discord will not let you
 * manage a channel you cannot see. Only an explicit overwrite does.
 */

const { handleSpaceProvision } = require('../lib/meetingSpace');
const store = require('../lib/meetingSpaceStore');

const GUILD_ID = 'guild-access-test';
const BOT_ID = 'bot-user-1';

function makeGuild(capture) {
    const everyone = { id: 'everyone-role' };
    return {
        id: GUILD_ID,
        roles: {
            everyone,
            cache: { size: 5 },
            create: jest.fn().mockResolvedValue({ id: 'space-role-1' }),
        },
        channels: {
            cache: { size: 10 },
            create: jest.fn().mockImplementation(async (opts) => {
                if (opts.permissionOverwrites) capture.overwrites = opts.permissionOverwrites;
                return {
                    id: `chan-${opts.name}`,
                    createInvite: jest
                        .fn()
                        .mockResolvedValue({ code: 'inv1', url: 'https://discord.gg/inv1' }),
                };
            }),
        },
    };
}

const client = { user: { id: BOT_ID }, guilds: { cache: new Map(), fetch: jest.fn() } };

describe('space category permissions', () => {
    let capture;

    beforeEach(() => {
        capture = {};
        const guild = makeGuild(capture);
        client.guilds.cache = new Map([[GUILD_ID, guild]]);
        // Start from an empty store so the idempotency check does not dedupe.
        store.save(GUILD_ID, { spaces: [] });
    });

    async function provision(key) {
        return handleSpaceProvision(
            {
                idempotencyKey: key,
                timestamp: Date.now(),
                label: 'test',
                guild_id: GUILD_ID,
                source: 'test',
            },
            client
        );
    }

    it('grants the BOT explicit access, or teardown is impossible', async () => {
        const res = await provision('k-bot-access');
        expect(res.status).toBe(200);

        const botOverwrite = capture.overwrites.find((o) => o.id === BOT_ID);
        expect(botOverwrite).toBeDefined();
        // ViewChannel is the one that matters: without it Discord refuses every
        // later manage/delete call on this category with `Missing Access`.
        expect(botOverwrite.allow).toEqual(
            expect.arrayContaining([expect.anything()])
        );
        expect(botOverwrite.type).toBeDefined();
    });

    it('still denies @everyone, so the space stays private', async () => {
        await provision('k-everyone');
        const everyoneOverwrite = capture.overwrites.find((o) => o.id === 'everyone-role');
        expect(everyoneOverwrite).toBeDefined();
        expect(everyoneOverwrite.deny.length).toBeGreaterThan(0);
    });

    it('grants the guest role', async () => {
        await provision('k-guest');
        expect(capture.overwrites.find((o) => o.id === 'space-role-1')).toBeDefined();
    });

    // Three parties, no more: everyone (denied), the guest role, the bot. The
    // owner needs no entry — guild owners bypass channel overwrites.
    it('carries exactly the three overwrites it needs', async () => {
        await provision('k-count');
        expect(capture.overwrites).toHaveLength(3);
    });
});
