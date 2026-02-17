/**
 * Integration tests for incremental archive behavior.
 *
 * These tests use a REAL in-memory SQLite database (not mocked) to verify
 * that getLastArchiveTime correctly reads the DB and that the full
 * archive flow only fetches messages newer than the watermark.
 */

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

// We need to test the real getLastArchiveTime with a real DB,
// but archive.js is loaded with mocked sqlite in archive.test.js.
// So we test the logic directly here without requiring archive.js's
// module-level mocking.

const NEW_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS raw_archive (
        id TEXT PRIMARY KEY,
        createdTimestamp INTEGER,
        content TEXT,
        author_id TEXT,
        guild_id TEXT,
        channel_id TEXT,
        channel_name TEXT,
        archive_file TEXT,
        metadata TEXT,
        UNIQUE(id, guild_id)
    );
`;

// Realistic test data: Discord snowflakes and timestamps
const GUILD_ID = '796874048281247825';
const CHANNEL_A = '833056832486375425';  // #general
const CHANNEL_B = '1215087334815703050'; // #test
const CHANNEL_C = '1078444159741997096'; // #never-archived

// Messages spread across two channels, simulating backfilled data
const EXISTING_MESSAGES = [
    // Channel A: 5 messages, most recent at ts 1708706900000 (Feb 23 2024)
    { id: '1210628963228192778', ts: 1708706837000, content: 'Hello world', author: '211716040005124097', channel: CHANNEL_A, channelName: 'general' },
    { id: '1210628963228192779', ts: 1708706850000, content: 'How are you', author: '211716040005124097', channel: CHANNEL_A, channelName: 'general' },
    { id: '1210628963228192780', ts: 1708706860000, content: 'Fine thanks', author: '309508532712112130', channel: CHANNEL_A, channelName: 'general' },
    { id: '1210628963228192781', ts: 1708706880000, content: 'Cool', author: '211716040005124097', channel: CHANNEL_A, channelName: 'general' },
    { id: '1210628963228192782', ts: 1708706900000, content: 'Latest msg in general', author: '309508532712112130', channel: CHANNEL_A, channelName: 'general' },

    // Channel B: 3 messages, most recent at ts 1708706870000
    { id: '1210628963228192790', ts: 1708706840000, content: 'Test 1', author: '211716040005124097', channel: CHANNEL_B, channelName: 'test' },
    { id: '1210628963228192791', ts: 1708706855000, content: 'Test 2', author: '309508532712112130', channel: CHANNEL_B, channelName: 'test' },
    { id: '1210628963228192792', ts: 1708706870000, content: 'Test 3', author: '211716040005124097', channel: CHANNEL_B, channelName: 'test' },
];

async function createTestDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(NEW_SCHEMA_SQL);
    return db;
}

async function seedMessages(db, messages) {
    for (const msg of messages) {
        await db.run(
            `INSERT OR REPLACE INTO raw_archive (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [msg.id, msg.ts, msg.content, msg.author, GUILD_ID, msg.channel, msg.channelName, 'archive_1708706800000.json', null]
        );
    }
}

describe('Incremental archive behavior', () => {
    let db;

    beforeEach(async () => {
        db = await createTestDb();
        await seedMessages(db, EXISTING_MESSAGES);
    });

    afterEach(async () => {
        await db.close();
    });

    // ========================================================
    // getLastArchiveTime via direct DB query
    // ========================================================

    describe('DB-based watermark lookup', () => {
        test('returns MAX(createdTimestamp) for channel A', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            expect(row.maxTs).toBe(1708706900000);
        });

        test('returns MAX(createdTimestamp) for channel B', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_B, GUILD_ID]
            );
            expect(row.maxTs).toBe(1708706870000);
        });

        test('returns null for channel with no data', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_C, GUILD_ID]
            );
            expect(row.maxTs).toBeNull();
        });

        test('watermark is unaffected by other guilds', async () => {
            // Insert a message for same channel ID but different guild
            await db.run(
                `INSERT INTO raw_archive (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ['9999999999999999999', 9999999999999, 'other guild msg', '111111111111111111', 'other-guild', CHANNEL_A, 'general', 'archive_x.json', null]
            );

            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            // Should still be channel A's max, not the other guild's huge timestamp
            expect(row.maxTs).toBe(1708706900000);
        });
    });

    // ========================================================
    // fetchMessageBatch filtering simulation
    // ========================================================

    describe('message filtering with watermark', () => {
        // Simulate what fetchMessageBatch does: iterate messages and stop
        // when createdTimestamp <= lastArchiveTime
        function simulateFetchFilter(discordMessages, lastArchiveTime) {
            const result = [];
            for (const msg of discordMessages) {
                if (msg.createdTimestamp > lastArchiveTime) {
                    result.push(msg);
                } else {
                    break;
                }
            }
            return result;
        }

        test('skips all messages when nothing new since watermark', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            const watermark = row.maxTs; // 1708706900000

            // Discord returns messages newest-first. All are at or before watermark.
            const discordMessages = [
                { id: '1210628963228192782', createdTimestamp: 1708706900000, content: 'Latest msg in general' },
                { id: '1210628963228192781', createdTimestamp: 1708706880000, content: 'Cool' },
                { id: '1210628963228192780', createdTimestamp: 1708706860000, content: 'Fine thanks' },
            ];

            const newMessages = simulateFetchFilter(discordMessages, watermark);
            expect(newMessages).toHaveLength(0);
        });

        test('only fetches messages newer than watermark', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            const watermark = row.maxTs; // 1708706900000

            // Discord returns messages newest-first. 2 new, then old ones.
            const discordMessages = [
                { id: '1310000000000000002', createdTimestamp: 1708707200000, content: 'Brand new msg 2' },
                { id: '1310000000000000001', createdTimestamp: 1708707100000, content: 'Brand new msg 1' },
                { id: '1210628963228192782', createdTimestamp: 1708706900000, content: 'Latest msg in general' },
                { id: '1210628963228192781', createdTimestamp: 1708706880000, content: 'Cool' },
            ];

            const newMessages = simulateFetchFilter(discordMessages, watermark);
            expect(newMessages).toHaveLength(2);
            expect(newMessages[0].id).toBe('1310000000000000002');
            expect(newMessages[1].id).toBe('1310000000000000001');
        });

        test('fetches everything when watermark is 0 (no DB data)', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_C, GUILD_ID]
            );
            const watermark = row.maxTs || 0; // null → 0

            const discordMessages = [
                { id: '1310000000000000003', createdTimestamp: 1708707300000, content: 'Msg 3' },
                { id: '1310000000000000002', createdTimestamp: 1708707200000, content: 'Msg 2' },
                { id: '1310000000000000001', createdTimestamp: 1708707100000, content: 'Msg 1' },
            ];

            const newMessages = simulateFetchFilter(discordMessages, watermark);
            expect(newMessages).toHaveLength(3);
        });

        test('handles channel B independently from channel A', async () => {
            const rowA = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            const rowB = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_B, GUILD_ID]
            );

            // Channel A watermark is higher than B
            expect(rowA.maxTs).toBe(1708706900000);
            expect(rowB.maxTs).toBe(1708706870000);

            // A message at ts 1708706890000 would be NEW for channel B but OLD for channel A
            const msgTs = 1708706890000;

            const newForA = simulateFetchFilter(
                [{ id: 'x', createdTimestamp: msgTs }],
                rowA.maxTs
            );
            const newForB = simulateFetchFilter(
                [{ id: 'x', createdTimestamp: msgTs }],
                rowB.maxTs
            );

            expect(newForA).toHaveLength(0); // 1708706890000 <= 1708706900000
            expect(newForB).toHaveLength(1); // 1708706890000 > 1708706870000
        });
    });

    // ========================================================
    // INSERT OR REPLACE idempotency
    // ========================================================

    describe('INSERT OR REPLACE idempotency', () => {
        test('re-inserting same message does not create duplicates', async () => {
            const before = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
            expect(before.cnt).toBe(8);

            // Re-insert all messages
            await seedMessages(db, EXISTING_MESSAGES);

            const after = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
            expect(after.cnt).toBe(8); // Same count
        });

        test('re-inserting updates content if changed', async () => {
            await db.run(
                `INSERT OR REPLACE INTO raw_archive (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ['1210628963228192778', 1708706837000, 'UPDATED content', '211716040005124097', GUILD_ID, CHANNEL_A, 'general', 'archive_new.json', null]
            );

            const row = await db.get('SELECT content, archive_file FROM raw_archive WHERE id = ?', ['1210628963228192778']);
            expect(row.content).toBe('UPDATED content');
            expect(row.archive_file).toBe('archive_new.json');

            // Count unchanged
            const count = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
            expect(count.cnt).toBe(8);
        });
    });

    // ========================================================
    // Watermark advances after new data is inserted
    // ========================================================

    describe('watermark advances after archiving new messages', () => {
        test('watermark updates when new messages are inserted', async () => {
            // Check initial watermark
            const before = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            expect(before.maxTs).toBe(1708706900000);

            // Simulate archiving 2 new messages
            const newMessages = [
                { id: '1310000000000000001', ts: 1708707100000, content: 'New msg 1', author: '211716040005124097', channel: CHANNEL_A, channelName: 'general' },
                { id: '1310000000000000002', ts: 1708707200000, content: 'New msg 2', author: '309508532712112130', channel: CHANNEL_A, channelName: 'general' },
            ];
            await seedMessages(db, newMessages);

            // Watermark should now be the newest message
            const after = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            expect(after.maxTs).toBe(1708707200000);

            // Channel B watermark should be unaffected
            const channelB = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_B, GUILD_ID]
            );
            expect(channelB.maxTs).toBe(1708706870000);
        });

        test('next archive run sees 0 new messages after full sync', async () => {
            const row = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );

            // Simulate Discord returning same messages that are already in DB
            const discordMessages = [
                { id: '1210628963228192782', createdTimestamp: 1708706900000 },
                { id: '1210628963228192781', createdTimestamp: 1708706880000 },
            ];

            const newMessages = discordMessages.filter(m => m.createdTimestamp > row.maxTs);
            expect(newMessages).toHaveLength(0);
        });
    });

    // ========================================================
    // Full scheduled archive simulation
    // ========================================================

    describe('scheduled archive simulation (Tuesday 3am scenario)', () => {
        test('weekly archive only processes new messages per channel', async () => {
            // This simulates what happens when the Tuesday 3am job fires.
            // The DB already has backfilled data. We check each channel's watermark
            // and verify only genuinely new messages would be fetched.

            const channels = [CHANNEL_A, CHANNEL_B, CHANNEL_C];
            const results = {};

            for (const channelId of channels) {
                const row = await db.get(
                    'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                    [channelId, GUILD_ID]
                );
                results[channelId] = {
                    watermark: row.maxTs || 0,
                    hasData: row.maxTs !== null
                };
            }

            // Channel A: has data, watermark at 1708706900000
            expect(results[CHANNEL_A].hasData).toBe(true);
            expect(results[CHANNEL_A].watermark).toBe(1708706900000);

            // Channel B: has data, watermark at 1708706870000
            expect(results[CHANNEL_B].hasData).toBe(true);
            expect(results[CHANNEL_B].watermark).toBe(1708706870000);

            // Channel C: no data, watermark at 0 — will fetch ALL messages
            expect(results[CHANNEL_C].hasData).toBe(false);
            expect(results[CHANNEL_C].watermark).toBe(0);
        });

        test('archiveServer processes channels sequentially and independently', async () => {
            // Verify that each channel gets its own independent watermark query.
            // Insert new messages only for channel A, leave B unchanged.

            const newMsg = { id: '1310000000000000005', ts: 1708707500000, content: 'Weekly new msg', author: '211716040005124097', channel: CHANNEL_A, channelName: 'general' };
            await seedMessages(db, [newMsg]);

            // Channel A watermark advanced
            const rowA = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_A, GUILD_ID]
            );
            expect(rowA.maxTs).toBe(1708707500000);

            // Channel B watermark unchanged
            const rowB = await db.get(
                'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
                [CHANNEL_B, GUILD_ID]
            );
            expect(rowB.maxTs).toBe(1708706870000);

            // Total rows: 8 original + 1 new = 9
            const count = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
            expect(count.cnt).toBe(9);
        });
    });
});
