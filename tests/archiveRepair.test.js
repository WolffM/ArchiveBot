/**
 * The by-name repair against a real channel folder under the per-file state
 * root and a real HTTP server standing in for Discord's CDN. Discord's REST
 * refresh-urls call is the one stub: it re-signs URLs onto that server.
 */
jest.mock('../utils/helper', () => ({
    ...jest.requireActual('../utils/helper'),
    delay: () => Promise.resolve(),
}));

const fs = require('fs');
const http = require('http');
const path = require('path');
const repair = require('../lib/archiveRepair');

const GUILD = '1200000000000000009';
const CDN = (id, name) => `https://cdn.discordapp.com/attachments/1100000000000000009/${id}/${name}?ex=1&is=2&hm=3`;

let server;
let base;
const bodies = new Map();

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const body = bodies.get(req.url);
        if (!body) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200);
        res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

let folder;
beforeEach(() => {
    bodies.clear();
    folder = path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, GUILD, `memes_1100000000000000009`);
    fs.rmSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, GUILD), { recursive: true, force: true });
    fs.mkdirSync(path.join(folder, 'attachments'), { recursive: true });
});

function att(id, name, body) {
    return { id, name, size: Buffer.byteLength(body), url: CDN(id, name), contentType: 'image/png' };
}

function writeArchive(file, messages) {
    fs.writeFileSync(path.join(folder, file), JSON.stringify(messages.map(([id, attachments]) => ({
        id, createdTimestamp: 0, content: '', metadata: { attachments },
    }))));
}

function onDisk(name, body) {
    fs.writeFileSync(path.join(folder, 'attachments', name), body);
}

// image.png posted three times: the last one survived on disk, the first two
// were overwritten. notes.txt was never collided. old.gif has no record at all.
const A = att('1400000000000000001', 'image.png', 'first');
const B = att('1400000000000000002', 'image.png', 'second!');
const C = att('1400000000000000003', 'image.png', 'the third one');
const N = att('1400000000000000004', 'notes.txt', 'notes');

function seed() {
    writeArchive('archive_1.json', [['1300000000000000001', [A]], ['1300000000000000002', [B]]]);
    writeArchive('archive_2.json', [['1300000000000000003', [C, N]]]);
    onDisk('image.png', 'the third one');
    onDisk('notes.txt', 'notes');
    onDisk('old.gif', 'from before attachment metadata');
}

function rest(gone = new Set()) {
    return {
        post: jest.fn(async (route, { body }) => {
            expect(route).toBe('/attachments/refresh-urls');
            return {
                refreshed_urls: body.attachment_urls
                    .filter((u) => !gone.has(repair.attachmentIdOf(u)))
                    .map((u) => ({ original: u, refreshed: `${base}/${repair.attachmentIdOf(u)}` })),
            };
        }),
    };
}

describe('planChannel', () => {
    test('maps survivors by size, recovers the overwritten, keeps the unrecorded', () => {
        seed();
        const plan = repair.planChannel(folder);
        expect(plan.rename.map((r) => [r.from, r.to]).sort()).toEqual([
            ['image.png', `${C.id}_image.png`],
            ['notes.txt', `${N.id}_notes.txt`],
        ]);
        expect(plan.recover.map((a) => a.id).sort()).toEqual([A.id, B.id]);
        expect(plan.legacy).toEqual(['old.gif']);
        expect(plan.ok).toEqual([]);
    });

    test('a by-name file whose size matches two attachments is not guessed at', () => {
        const twin = att('1400000000000000005', 'image.png', 'the third one');
        writeArchive('archive_1.json', [['1300000000000000003', [C]], ['1300000000000000005', [twin]]]);
        onDisk('image.png', 'the third one');
        const plan = repair.planChannel(folder);
        expect(plan.rename).toEqual([]);
        expect(plan.recover.map((a) => a.id).sort()).toEqual([C.id, twin.id]);
        expect(plan.legacy).toEqual(['image.png']);
    });

    test('an already-repaired channel is all ok', () => {
        writeArchive('archive_1.json', [['1300000000000000004', [N]]]);
        onDisk(`${N.id}_notes.txt`, 'notes');
        const plan = repair.planChannel(folder);
        expect(plan.ok.map((a) => a.id)).toEqual([N.id]);
        expect(plan.rename.length + plan.recover.length + plan.legacy.length).toBe(0);
    });
});

describe('repairGuild', () => {
    test('a dry run changes nothing', async () => {
        seed();
        const before = fs.readdirSync(path.join(folder, 'attachments')).sort();
        const r = rest();
        const t = await repair.repairGuild(GUILD, { rest: r, apply: false });
        expect(t).toMatchObject({ channels: 1, rename: 2, recover: 2, legacy: 1, renamed: 0, recovered: 0 });
        expect(fs.readdirSync(path.join(folder, 'attachments')).sort()).toEqual(before);
        expect(r.post).not.toHaveBeenCalled();
    });

    test('apply renames, recovers what Discord still has, and counts the rest gone', async () => {
        seed();
        bodies.set(`/${A.id}`, 'first');
        const t = await repair.repairGuild(GUILD, { rest: rest(new Set([B.id])), apply: true });
        expect(t).toMatchObject({ renamed: 2, recovered: 1, gone: 1, failed: 0 });

        const dir = path.join(folder, 'attachments');
        expect(fs.readdirSync(dir).sort()).toEqual([
            `${A.id}_image.png`, `${C.id}_image.png`, `${N.id}_notes.txt`, 'old.gif',
        ]);
        expect(fs.readFileSync(path.join(dir, `${A.id}_image.png`), 'utf8')).toBe('first');
        expect(fs.readFileSync(path.join(dir, `${C.id}_image.png`), 'utf8')).toBe('the third one');

        // A second run finds only what is truly gone.
        const again = await repair.repairGuild(GUILD, { rest: rest(new Set([B.id])), apply: false });
        expect(again).toMatchObject({ ok: 3, rename: 0, recover: 1, legacy: 1 });
    });

    test('a refreshed URL that 404s is gone, not failed', async () => {
        writeArchive('archive_1.json', [['1300000000000000001', [A]]]);
        const t = await repair.repairGuild(GUILD, { rest: rest(), apply: true });
        expect(t).toMatchObject({ recovered: 0, gone: 1, failed: 0 });
    });

    test('a refresh-urls error fails the batch and the run goes on', async () => {
        writeArchive('archive_1.json', [['1300000000000000001', [A]]]);
        const broken = { post: jest.fn().mockRejectedValue(new Error('rate limited')) };
        const t = await repair.repairGuild(GUILD, { rest: broken, apply: true });
        expect(t).toMatchObject({ recovered: 0, failed: 1 });
    });
});

test('attachmentIdOf reads the id out of a CDN URL', () => {
    expect(repair.attachmentIdOf(CDN('1400000000000000007', 'x.png'))).toBe('1400000000000000007');
    expect(repair.attachmentIdOf('https://example.com/nope')).toBeNull();
});

describe('one applying run per guild', () => {
    test('a second apply is refused while the first runs, and allowed after', async () => {
        writeArchive('archive_1.json', [['1300000000000000001', [A]]]);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const slow = { post: jest.fn(async () => { await gate; return { refreshed_urls: [] }; }) };

        const first = repair.repairGuild(GUILD, { rest: slow, apply: true });
        expect(repair.isRunning(GUILD)).toBe(true);
        await expect(repair.repairGuild(GUILD, { rest: slow, apply: true })).rejects.toThrow(/already running/);
        await expect(repair.repairGuild(GUILD, { rest: slow })).resolves.toMatchObject({ recover: 1 });

        release();
        await first;
        expect(repair.isRunning(GUILD)).toBe(false);
    });
});

describe('repairAll', () => {
    const BROKEN = '1200000000000000008';
    const brokenDir = () => path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, BROKEN);
    afterEach(() => fs.rmSync(brokenDir(), { recursive: true, force: true }));

    test('applies to every guild folder, and one that fails does not stop the rest', async () => {
        seed();
        bodies.set(`/${A.id}`, 'first');
        bodies.set(`/${B.id}`, 'second!');
        fs.mkdirSync(path.join(brokenDir(), 'general_1100000000000000008'), { recursive: true });
        fs.writeFileSync(path.join(brokenDir(), 'general_1100000000000000008', 'archive_1.json'), '{not json');
        fs.mkdirSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, 'tasklist'), { recursive: true });

        expect(repair.archivedGuilds()).toEqual([BROKEN, GUILD]);
        const results = await repair.repairAll({ rest: rest() });
        expect(Object.keys(results).sort()).toEqual([BROKEN, GUILD]);
        expect(results[BROKEN].error).toMatch(/JSON/);
        expect(results[GUILD]).toMatchObject({ renamed: 2, recovered: 2, gone: 0, failed: 0 });
        expect(repair.isRunning(GUILD)).toBe(false);
    });
});

describe('/archiverepair', () => {
    const { createCommandsList } = require('../commands');

    function interaction(apply, send = jest.fn().mockResolvedValue(undefined)) {
        return {
            guildId: GUILD,
            guild: { name: 'Test Guild' },
            user: { id: '1500000000000000009', send },
            client: { rest: rest() },
            options: { getBoolean: () => apply },
            deferReply: jest.fn().mockResolvedValue(undefined),
            editReply: jest.fn().mockResolvedValue(undefined),
        };
    }

    test('a dry run answers in the interaction', async () => {
        seed();
        const i = interaction(null);
        await createCommandsList().archiverepair.execute(i);
        expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('2 to rename, 2 to recover, 1 unrecorded'));
        expect(i.user.send).not.toHaveBeenCalled();
    });

    test('apply answers at once and DMs the result when the run ends', async () => {
        seed();
        bodies.set(`/${A.id}`, 'first');
        bodies.set(`/${B.id}`, 'second!');
        let delivered;
        const done = new Promise((resolve) => { delivered = resolve; });
        const i = interaction(true, jest.fn(async (msg) => delivered(msg)));
        await createCommandsList().archiverepair.execute(i);
        expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("I'll DM you the result"));
        expect(await done).toContain('Renamed 2, recovered 2, gone from Discord 0, failed 0.');
    });

    test('a DM that cannot be delivered is logged, not thrown', async () => {
        seed();
        let failed;
        const tried = new Promise((resolve) => { failed = resolve; });
        const i = interaction(true, jest.fn(async () => { failed(); throw new Error('Cannot send messages to this user'); }));
        await createCommandsList().archiverepair.execute(i);
        await tried;
        await new Promise((resolve) => setImmediate(resolve));
        expect(repair.isRunning(GUILD)).toBe(false);
    });
});
