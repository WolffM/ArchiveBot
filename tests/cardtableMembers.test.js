/**
 * Linked members of the cardtable guild: prefs-api's signed sync gives a linked
 * Discord account the Linked role and its hadoku name as nickname, takes both
 * away on unlink, and a link made before joining applies on the join.
 */

jest.mock('../lib/ledger', () => ({
    mirrorToLedger: jest.fn(),
    mirrorFailureToLedger: jest.fn(),
}));

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createMockLayoutGuild } = require('./mocks/discord');
const setup = require('../lib/cardtableSetup');
const store = require('../lib/cardtableStore');
const members = require('../lib/cardtableMembers');
const { createHandler } = require('../lib/webhookServer');

const OWNER = '100000000000000001';
const ALICE = '200000000000000002';
const BOB = '300000000000000003';
const PREFS_SECRET = 'prefs-secret-value';

let guild;
let client;
let linkedRole;

beforeEach(async () => {
    guild = createMockLayoutGuild({ id: `guild-${Math.random().toString(36).slice(2)}`, ownerId: OWNER });
    guild.addMember(OWNER);
    guild.addMember('bot-user-id', { bot: true });
    const { record } = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
    linkedRole = record.roles.linked;
    client = { guilds: { cache: new Map([[guild.id, guild]]), fetch: jest.fn() }, isReady: () => true };
});

afterEach(() => {
    for (const id of store.listBoundGuildIds()) {
        fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, id, 'cardtable.json'));
    }
});

const sync = (payload) => members.handleMembersSync(payload, client);

describe('handleMembersSync', () => {
    test('a member in the guild gets Linked and their hadoku name', async () => {
        const alice = guild.addMember(ALICE);
        const { status, body } = await sync({ set: [{ id: ALICE, name: 'alice' }] });
        expect(status).toBe(200);
        expect(body).toMatchObject({ success: true, applied: 1, absent: 0, failed: 0 });
        expect(alice.roles.cache.has(linkedRole)).toBe(true);
        expect(alice.nickname).toBe('alice');
        expect(store.getLinks(guild.id)[ALICE].name).toBe('alice');
    });

    test('a second identical sync changes nothing on Discord', async () => {
        const alice = guild.addMember(ALICE);
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        expect(alice.roles.add).toHaveBeenCalledTimes(1);
        expect(alice.setNickname).toHaveBeenCalledTimes(1);
    });

    test('a rename moves the nickname and keeps linkedAt', async () => {
        const alice = guild.addMember(ALICE);
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        const { linkedAt } = store.getLinks(guild.id)[ALICE];
        await sync({ set: [{ id: ALICE, name: 'Alice the Bold' }] });
        expect(alice.nickname).toBe('Alice the Bold');
        expect(store.getLinks(guild.id)[ALICE]).toEqual({ name: 'Alice the Bold', linkedAt });
    });

    test('someone not in the guild is stored, counted absent, and applied on join', async () => {
        const { body } = await sync({ set: [{ id: BOB, name: 'bob' }] });
        expect(body).toMatchObject({ applied: 0, absent: 1 });
        const bob = guild.addMember(BOB);
        const done = await members.handleLinkedJoin(bob);
        expect(done).toEqual({ role: 'added', nickname: 'set' });
        expect(bob.roles.cache.has(linkedRole)).toBe(true);
        expect(bob.nickname).toBe('bob');
    });

    test('a join with no link is left alone', async () => {
        const bob = guild.addMember(BOB);
        expect(await members.handleLinkedJoin(bob)).toBeNull();
        expect(bob.roles.add).not.toHaveBeenCalled();
    });

    test('the owner and a member above the bot get the role but keep their nickname', async () => {
        const owner = guild.members.list.get(OWNER);
        const high = guild.addMember(ALICE, { manageable: false });
        const { body } = await sync({ set: [{ id: OWNER, name: 'operator' }, { id: ALICE, name: 'alice' }] });
        expect(body).toMatchObject({ applied: 2, failed: 0 });
        for (const m of [owner, high]) {
            expect(m.roles.cache.has(linkedRole)).toBe(true);
            expect(m.setNickname).not.toHaveBeenCalled();
        }
    });

    test('unlink takes the role and our nickname away, and forgets the link', async () => {
        const alice = guild.addMember(ALICE);
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        const { body } = await sync({ remove: [ALICE] });
        expect(body).toMatchObject({ removed: 1 });
        expect(alice.roles.cache.has(linkedRole)).toBe(false);
        expect(alice.nickname).toBeNull();
        expect(store.getLinks(guild.id)[ALICE]).toBeUndefined();
    });

    test('unlink leaves a nickname the member chose since', async () => {
        const alice = guild.addMember(ALICE);
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        alice.nickname = 'my own pick';
        await sync({ remove: [ALICE] });
        expect(alice.nickname).toBe('my own pick');
    });

    test('a Discord refusal counts as failed and keeps the stored link', async () => {
        const alice = guild.addMember(ALICE);
        alice.setNickname.mockRejectedValueOnce(Object.assign(new Error('Invalid Form Body'), { code: 50035 }));
        const { status, body } = await sync({ set: [{ id: ALICE, name: 'alice' }] });
        expect(status).toBe(200);
        expect(body).toMatchObject({ applied: 0, failed: 1 });
        expect(store.getLinks(guild.id)[ALICE].name).toBe('alice');
    });

    describe('a guild set up before Linked existed', () => {
        // The live guild: /setup ran before the layout had Linked, so neither
        // the role nor its id is there.
        beforeEach(() => {
            const recorded = store.getSetup(guild.id);
            guild.roles.cache.delete(recorded.roles.linked);
            const { linked, ...roles } = recorded.roles;
            store.saveSetup(guild.id, { ...recorded, roles });
            guild.roles.create.mockClear();
            for (const c of guild.channels.cache.values()) {
                c.setParent.mockClear();
                c.permissionOverwrites.edit.mockClear();
            }
            guild.channels.create.mockClear();
        });

        test('the first sync makes Linked, records it and touches no channel', async () => {
            const alice = guild.addMember(ALICE);
            await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(guild.roles.create).toHaveBeenCalledTimes(1);
            expect(guild.roles.create.mock.calls[0][0]).toMatchObject({ name: 'Linked', permissions: [], mentionable: false });
            const roleId = store.getSetup(guild.id).roles.linked;
            expect(alice.roles.cache.has(roleId)).toBe(true);
            expect(alice.nickname).toBe('alice');
            expect(guild.channels.create).not.toHaveBeenCalled();
            for (const c of guild.channels.cache.values()) {
                expect(c.setParent).not.toHaveBeenCalled();
                expect(c.permissionOverwrites.edit).not.toHaveBeenCalled();
            }
            await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(guild.roles.create).toHaveBeenCalledTimes(1);
        });

        test('everyone linked before the role existed gets it with the first sync', async () => {
            const bob = guild.addMember(BOB);
            store.saveLinks(guild.id, { [BOB]: { name: 'bob', linkedAt: '2026-11-04T00:00:00.000Z' } });
            guild.addMember(ALICE);
            await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(bob.roles.cache.has(store.getSetup(guild.id).roles.linked)).toBe(true);
        });

        test('a Linked role made by hand is adopted, not duplicated', async () => {
            const made = await guild.roles.create({ name: 'linked', permissions: [] });
            guild.roles.create.mockClear();
            const alice = guild.addMember(ALICE);
            await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(guild.roles.create).not.toHaveBeenCalled();
            expect(store.getSetup(guild.id).roles.linked).toBe(made.id);
            expect(alice.roles.cache.has(made.id)).toBe(true);
        });

        test('two syncs at once make one role', async () => {
            guild.addMember(ALICE);
            guild.addMember(BOB);
            await Promise.all([sync({ set: [{ id: ALICE, name: 'alice' }] }), sync({ set: [{ id: BOB, name: 'bob' }] })]);
            expect(guild.roles.create).toHaveBeenCalledTimes(1);
        });

        test('a linked join makes it too', async () => {
            await sync({ set: [{ id: BOB, name: 'bob' }] });
            const bob = guild.addMember(BOB);
            expect(await members.handleLinkedJoin(bob)).toEqual({ role: 'added', nickname: 'set' });
        });

        test('a create Discord refuses still sets nicknames', async () => {
            guild.failOn((kind) => kind === 'role');
            const alice = guild.addMember(ALICE);
            const { body } = await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(body).toMatchObject({ applied: 1, failed: 0 });
            expect(alice.nickname).toBe('alice');
            expect(alice.roles.add).not.toHaveBeenCalled();
            expect(store.getSetup(guild.id).roles.linked).toBeUndefined();
        });

        test('a Linked above the bot is recorded but not handed out', async () => {
            const made = await guild.roles.create({ name: 'Linked', permissions: [] });
            made.editable = false;
            const alice = guild.addMember(ALICE);
            await sync({ set: [{ id: ALICE, name: 'alice' }] });
            expect(alice.roles.add).not.toHaveBeenCalled();
            expect(alice.nickname).toBe('alice');
        });
    });

    test.each([
        ['no lists', {}],
        ['two empty lists', { set: [], remove: [] }],
        ['an id that is not a snowflake', { set: [{ id: 'nope', name: 'x' }] }],
        ['a blank name', { set: [{ id: ALICE, name: '   ' }] }],
        ['no name', { set: [{ id: ALICE }] }],
        ['a numeric remove', { remove: [42] }],
        ['101 entries', { set: Array.from({ length: 101 }, (_, i) => ({ id: `${ALICE.slice(0, -3)}${String(i).padStart(3, '0')}`, name: 'n' })) }],
    ])('refuses %s', async (_label, payload) => {
        const { status, body } = await sync(payload);
        expect(status).toBe(400);
        expect(body.error).toBe('invalid_members');
    });

    test('503 before /setup cardtable', async () => {
        fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, guild.id, 'cardtable.json'));
        const { status, body } = await sync({ set: [{ id: ALICE, name: 'alice' }] });
        expect(status).toBe(503);
        expect(body.error).toBe('cardtable_guild_not_set_up');
    });
});

describe('nicknameFor', () => {
    test('trims, drops control characters and caps at 32 code points', () => {
        expect(members.nicknameFor('  al\u0007ice  ')).toBe('alice');
        expect([...members.nicknameFor('🃏'.repeat(40))]).toHaveLength(32);
    });
});

describe('re-running /setup cardtable', () => {
    test('applies every stored link to members already here', async () => {
        await sync({ set: [{ id: ALICE, name: 'alice' }] });
        const alice = guild.addMember(ALICE);
        const { report } = await setup.applyCardtableLayout(guild, { appliedBy: OWNER });
        expect(report.members.linked).toBe(1);
        expect(alice.nickname).toBe('alice');
        expect(alice.roles.cache.has(linkedRole)).toBe(true);
    });
});

describe('POST /api/discord/members/sync', () => {
    function post(payload, secret) {
        const handler = createHandler({ discordClient: client, prefsSecret: PREFS_SECRET, commit: 'test' });
        return new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.listen(0, '127.0.0.1', () => {
                const raw = Buffer.from(JSON.stringify(payload));
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port: server.address().port,
                        path: '/api/discord/members/sync',
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'content-length': raw.length,
                            'x-hadoku-signature': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`,
                        },
                    },
                    (res) => {
                        let data = '';
                        res.on('data', (c) => { data += c; });
                        res.on('end', () => {
                            server.close();
                            resolve({ status: res.statusCode, body: JSON.parse(data) });
                        });
                    }
                );
                req.on('error', reject);
                req.end(raw);
            });
        });
    }

    test("prefs-api's signature reaches the handler", async () => {
        const alice = guild.addMember(ALICE);
        const { status, body } = await post({ set: [{ id: ALICE, name: 'alice' }] }, PREFS_SECRET);
        expect(status).toBe(200);
        expect(body.applied).toBe(1);
        expect(alice.nickname).toBe('alice');
    });

    test('any other secret is refused', async () => {
        const { status } = await post({ set: [{ id: ALICE, name: 'alice' }] }, 'cardtable-secret');
        expect(status).toBe(401);
    });
});
