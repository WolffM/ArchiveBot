/**
 * The weekly sweep archives every guild the bot is in, with no per-guild
 * opt-in, and retires the archive_server reminders that used to be the opt-in.
 * Runs against the per-file state root (tests/setup.stateRoot.js), on disk.
 */
const mockLog = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    success: jest.fn(), fail: jest.fn(),
};
jest.mock('../utils/logger', () => ({ createLogger: () => mockLog }));

const fs = require('fs');
const { outputPath } = require('../lib/paths');
const sweep = require('../lib/archiveSweep');
const { createMockCollection } = require('./mocks/discord');

const CHECKMATE = '198871224808505346';
const HADOKU = '796874048281247825';
const CARDTABLE = '1563307288406786078';
const STATUS_CHANNEL = '1212963925608501331';

function guild(id, name) {
    return { id, name };
}

function client(guilds) {
    return {
        guilds: { cache: createMockCollection(guilds.map(g => [g.id, g])) },
        channels: { fetch: jest.fn(async (id) => ({ id, send: jest.fn() })) },
    };
}

function writeScheduled(guildId, items) {
    fs.mkdirSync(outputPath(guildId), { recursive: true });
    fs.writeFileSync(outputPath(guildId, 'scheduled.json'), JSON.stringify({ items }));
}

function readScheduled(guildId) {
    return JSON.parse(fs.readFileSync(outputPath(guildId, 'scheduled.json'), 'utf8'));
}

function start(c, archive) {
    // Timers far out: each test drives runSweep itself.
    sweep.startArchiveSweep(c, { archive, firstCheckMs: 1e9, checkMs: 1e9 });
}

beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(outputPath('archive-sweep.json'), { force: true });
    for (const id of [CHECKMATE, HADOKU, CARDTABLE]) fs.rmSync(outputPath(id), { recursive: true, force: true });
});

afterEach(() => sweep.stopArchiveSweep());

const counts = { total: 3, archived: 1, skipped: 2, errors: 0 };

describe('retireArchiveReminders', () => {
    test('deactivates archive_server reminders and keeps their channel as the status channel', () => {
        writeScheduled(CHECKMATE, [
            { id: 5, type: 'reminder', channelId: '1409222653427847178', recurring: '1w', active: true },
            { id: 8, type: 'reminder', channelId: STATUS_CHANNEL, message: '"Server archive"', recurring: '1w', active: true, action: 'archive_server' },
        ]);

        expect(sweep.retireArchiveReminders([CHECKMATE, CARDTABLE])).toBe(1);

        const items = readScheduled(CHECKMATE).items;
        expect(items.find(i => i.id === 8).active).toBe(false);
        expect(items.find(i => i.id === 5).active).toBe(true);
        expect(sweep.loadState().statusChannels).toEqual({ [CHECKMATE]: STATUS_CHANNEL });
        // A guild with no scheduled.json is read, not created.
        expect(fs.existsSync(outputPath(CARDTABLE, 'scheduled.json'))).toBe(false);
    });

    test('a second start retires nothing more', () => {
        writeScheduled(HADOKU, [{ id: 8, channelId: '833056832486375425', active: true, action: 'archive_server' }]);
        expect(sweep.retireArchiveReminders([HADOKU])).toBe(1);
        expect(sweep.retireArchiveReminders([HADOKU])).toBe(0);
    });
});

describe('runSweep', () => {
    test('archives every guild, posting status only where a status channel is configured', async () => {
        writeScheduled(CHECKMATE, [{ id: 8, channelId: STATUS_CHANNEL, active: true, action: 'archive_server' }]);
        sweep.retireArchiveReminders([CHECKMATE]);
        const archive = jest.fn(async () => counts);
        const c = client([guild(CHECKMATE, 'checkmate'), guild(CARDTABLE, 'Cardtable')]);
        start(c, archive);

        await sweep.runSweep();

        expect(archive).toHaveBeenCalledTimes(2);
        const [checkmateCall, cardtableCall] = archive.mock.calls;
        expect(checkmateCall[0].id).toBe(CHECKMATE);
        expect(checkmateCall[1].id).toBe(STATUS_CHANNEL);
        expect(cardtableCall[0].id).toBe(CARDTABLE);
        expect(cardtableCall[1]).toBeNull();
        expect(c.channels.fetch).toHaveBeenCalledTimes(1);
    });

    test('logs one line naming every guild and its outcome, and marks the run done', async () => {
        const archive = jest.fn(async (g) => {
            if (g.id === HADOKU) throw new Error('boom');
            return g.id === CARDTABLE ? { ...counts, errors: 1 } : counts;
        });
        start(client([guild(CHECKMATE, 'checkmate'), guild(HADOKU, "Hadoku's server"), guild(CARDTABLE, 'Cardtable')]), archive);

        await sweep.runSweep();

        const lines = mockLog.warn.mock.calls.filter(([action]) => action === 'archiveSweep');
        expect(lines).toHaveLength(1);
        const { guilds, results } = lines[0][1];
        expect(guilds).toBe(3);
        expect(results).toContain(`${CHECKMATE} "checkmate" ok archived=1 skipped=2 errors=0`);
        expect(results).toContain(`${HADOKU} "Hadoku's server" failed: boom`);
        expect(results).toContain(`${CARDTABLE} "Cardtable" partial`);
        const state = sweep.loadState();
        expect(state.guilds).toEqual([CHECKMATE, HADOKU, CARDTABLE]);
        expect(sweep.isDue(state)).toBe(false);
    });

    test('names a guild the previous sweep archived that this one did not', async () => {
        const archive = jest.fn(async () => counts);
        start(client([guild(CHECKMATE, 'checkmate'), guild(HADOKU, 'h')]), archive);
        await sweep.runSweep();
        expect(mockLog.success).toHaveBeenCalledWith('archiveSweep', expect.not.objectContaining({ dropped: expect.anything() }));
        sweep.stopArchiveSweep();

        start(client([guild(CHECKMATE, 'checkmate')]), archive);
        await sweep.runSweep();

        expect(mockLog.warn).toHaveBeenCalledWith('archiveSweep', expect.objectContaining({ guilds: 1, dropped: HADOKU }));
    });

    test('an unreachable status channel falls back to logging only', async () => {
        writeScheduled(CHECKMATE, [{ id: 8, channelId: STATUS_CHANNEL, active: true, action: 'archive_server' }]);
        sweep.retireArchiveReminders([CHECKMATE]);
        const c = client([guild(CHECKMATE, 'checkmate')]);
        c.channels.fetch.mockRejectedValue(Object.assign(new Error('Unknown Channel'), { code: 10003 }));
        const archive = jest.fn(async () => counts);
        start(c, archive);

        await sweep.runSweep();

        expect(archive).toHaveBeenCalledWith(expect.objectContaining({ id: CHECKMATE }), null, undefined);
    });
});

describe('isDue', () => {
    test('due with no previous run, not within a week, due after one', () => {
        const now = Date.parse('2026-11-17T12:00:00Z');
        expect(sweep.isDue({ lastRun: null }, now)).toBe(true);
        expect(sweep.isDue({ lastRun: '2026-11-11T12:00:00Z' }, now)).toBe(false);
        expect(sweep.isDue({ lastRun: '2026-11-10T12:00:00Z' }, now)).toBe(true);
    });
});

describe('one queue', () => {
    test('a guild joined, /archiveserver and the sweep never run two archives at once', async () => {
        let running = 0;
        let maxRunning = 0;
        const archive = jest.fn(async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(r => setImmediate(r));
            running--;
            return counts;
        });
        start(client([guild(CHECKMATE, 'checkmate'), guild(HADOKU, 'h')]), archive);

        await Promise.all([
            sweep.runSweep(),
            sweep.onGuildJoined(guild(CARDTABLE, 'Cardtable')),
            sweep.archiveGuild(guild(HADOKU, 'h'), { id: 'status' }),
        ]);

        expect(archive).toHaveBeenCalledTimes(4);
        expect(maxRunning).toBe(1);
        // A joined guild has no status channel: log only.
        expect(archive).toHaveBeenCalledWith(expect.objectContaining({ id: CARDTABLE }), null, undefined);
    });
});
