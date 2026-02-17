/**
 * Database Audit Script
 *
 * Exhaustive data integrity checks against archive SQLite databases.
 * Runs 13 checks per guild, records snapshots for regression detection.
 *
 * Usage:
 *   node scripts/audit-database.js                  # All guilds
 *   node scripts/audit-database.js --guild 12345    # Specific guild
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DISCORD_EPOCH_MS = 1420070400000;  // 2015-01-01
const MAX_TIMESTAMP_MS = 1893456000000;  // 2030-01-01

// ============ Check Definitions ============

async function checkNulls(db) {
    const rows = await db.all(`
        SELECT 'null_id' as chk, COUNT(*) as cnt FROM raw_archive WHERE id IS NULL
        UNION ALL SELECT 'null_timestamp', COUNT(*) FROM raw_archive WHERE createdTimestamp IS NULL
        UNION ALL SELECT 'null_author', COUNT(*) FROM raw_archive WHERE author_id IS NULL
        UNION ALL SELECT 'null_guild', COUNT(*) FROM raw_archive WHERE guild_id IS NULL
        UNION ALL SELECT 'null_channel_id', COUNT(*) FROM raw_archive WHERE channel_id IS NULL
        UNION ALL SELECT 'null_channel_name', COUNT(*) FROM raw_archive WHERE channel_name IS NULL
        UNION ALL SELECT 'null_archive_file', COUNT(*) FROM raw_archive WHERE archive_file IS NULL
    `);
    const failures = rows.filter(r => r.cnt > 0);
    return {
        name: 'NULLs in critical columns',
        type: 'hard',
        passed: failures.length === 0,
        details: failures.length > 0 ? failures : null
    };
}

async function checkSnowflakes(db) {
    // SQLite GLOB for 17+ digits: repeat [0-9] 17 times then *
    const sf17 = '[0-9]'.repeat(17) + '*';
    const rows = await db.all(`
        SELECT 'bad_msg_id' as chk, COUNT(*) as cnt
        FROM raw_archive WHERE id NOT GLOB '${sf17}' OR LENGTH(id) > 20
        UNION ALL
        SELECT 'bad_author_id', COUNT(*)
        FROM raw_archive WHERE author_id NOT GLOB '${sf17}' OR LENGTH(author_id) > 20
        UNION ALL
        SELECT 'bad_channel_id', COUNT(*)
        FROM raw_archive WHERE channel_id NOT GLOB '${sf17}' OR LENGTH(channel_id) > 20
    `);
    const failures = rows.filter(r => r.cnt > 0);
    return {
        name: 'Snowflake format',
        type: 'hard',
        passed: failures.length === 0,
        details: failures.length > 0 ? failures : null
    };
}

async function checkContentIntegrity(db) {
    const rows = await db.all(`
        SELECT 'null_content' as chk, COUNT(*) as cnt FROM raw_archive WHERE content IS NULL
        UNION ALL SELECT 'empty_content', COUNT(*) FROM raw_archive WHERE content = ''
        UNION ALL SELECT 'oversized_content', COUNT(*) FROM raw_archive WHERE LENGTH(content) > 4000
    `);
    return {
        name: 'Content integrity',
        type: 'info',
        passed: true,
        details: rows.filter(r => r.cnt > 0).length > 0 ? rows : null
    };
}

async function checkTimestamps(db) {
    const rows = await db.all(`
        SELECT 'ts_too_old' as chk, COUNT(*) as cnt FROM raw_archive WHERE createdTimestamp < ${DISCORD_EPOCH_MS}
        UNION ALL SELECT 'ts_too_new', COUNT(*) FROM raw_archive WHERE createdTimestamp > ${MAX_TIMESTAMP_MS}
        UNION ALL SELECT 'ts_is_float', COUNT(*) FROM raw_archive WHERE typeof(createdTimestamp) = 'real'
    `);
    const failures = rows.filter(r => r.cnt > 0);
    return {
        name: 'Timestamp plausibility',
        type: 'hard',
        passed: failures.length === 0,
        details: failures.length > 0 ? failures : null
    };
}

async function checkTimestampMonotonicity(db) {
    const rows = await db.all(`
        SELECT channel_id, COUNT(*) as inversions
        FROM (
            SELECT channel_id, id, createdTimestamp,
                LAG(createdTimestamp) OVER (PARTITION BY channel_id ORDER BY CAST(id AS INTEGER)) as prev_ts
            FROM raw_archive
        )
        WHERE createdTimestamp < prev_ts - 5000
        GROUP BY channel_id
        HAVING inversions > 0
    `);
    return {
        name: 'Timestamp monotonicity',
        type: 'hard',
        passed: rows.length === 0,
        details: rows.length > 0 ? rows : null
    };
}

async function checkGuildConsistency(db, guildId) {
    const row = await db.get(
        'SELECT COUNT(*) as mismatched FROM raw_archive WHERE guild_id != ?',
        [guildId]
    );
    return {
        name: 'Guild ID consistency',
        type: 'hard',
        passed: row.mismatched === 0,
        details: row.mismatched > 0 ? { mismatched: row.mismatched } : null
    };
}

async function checkChannelConsistency(db) {
    // Informational: channel renames (expected)
    const renames = await db.all(`
        SELECT channel_id, GROUP_CONCAT(DISTINCT channel_name) as names, COUNT(DISTINCT channel_name) as name_count
        FROM raw_archive GROUP BY channel_id HAVING name_count > 1
    `);

    // Hard fail: same name, different IDs (parsing bug)
    const collisions = await db.all(`
        SELECT channel_name, GROUP_CONCAT(DISTINCT channel_id) as ids, COUNT(DISTINCT channel_id) as id_count
        FROM raw_archive GROUP BY channel_name HAVING id_count > 1
    `);

    const details = {};
    if (renames.length > 0) details.renames = renames;
    if (collisions.length > 0) details.collisions = collisions;

    // Name collisions are expected — Discord allows deleting and recreating
    // channels with the same name (different snowflake IDs). Not a bug.
    return {
        name: 'Channel name consistency',
        type: 'info',
        passed: true,
        details: Object.keys(details).length > 0 ? details : null
    };
}

async function checkMetadataJson(db) {
    const row = await db.get(`
        SELECT COUNT(*) as bad_json FROM raw_archive
        WHERE metadata IS NOT NULL AND json_valid(metadata) = 0
    `);
    return {
        name: 'Metadata JSON validity (exhaustive)',
        type: 'hard',
        passed: row.bad_json === 0,
        details: row.bad_json > 0 ? { bad_json: row.bad_json } : null
    };
}

async function checkCoreFieldLeakage(db) {
    const row = await db.get(`
        SELECT COUNT(*) as leaked FROM raw_archive
        WHERE metadata IS NOT NULL AND (
            json_extract(metadata, '$.id') IS NOT NULL
            OR json_extract(metadata, '$.createdTimestamp') IS NOT NULL
            OR json_extract(metadata, '$.content') IS NOT NULL
        )
    `);
    return {
        name: 'Core field leakage into metadata',
        type: 'hard',
        passed: row.leaked === 0,
        details: row.leaked > 0 ? { leaked: row.leaked } : null
    };
}

async function checkArchiveFilesOnDisk(db, guildId) {
    const dbRefs = await db.all(`
        SELECT DISTINCT channel_name || '_' || channel_id as folder, archive_file
        FROM raw_archive
    `);

    const outputPath = path.join(__dirname, '..', 'Output', guildId);
    let dbMissing = [];
    for (const ref of dbRefs) {
        const filePath = path.join(outputPath, ref.folder, ref.archive_file);
        if (!fs.existsSync(filePath)) {
            dbMissing.push(ref.folder + '/' + ref.archive_file);
        }
    }

    // Scan disk for orphaned archive files not referenced in DB
    const dbFileSet = new Set(dbRefs.map(r => r.folder + '/' + r.archive_file));
    let diskOrphans = [];
    const guildEntries = fs.readdirSync(outputPath).filter(entry => {
        const fullPath = path.join(outputPath, entry);
        return fs.statSync(fullPath).isDirectory() && entry !== 'attachments';
    });

    for (const dir of guildEntries) {
        const dirPath = path.join(outputPath, dir);
        const archiveFiles = fs.readdirSync(dirPath)
            .filter(f => f.startsWith('archive_') && f.endsWith('.json'));
        for (const f of archiveFiles) {
            const key = dir + '/' + f;
            if (!dbFileSet.has(key)) {
                diskOrphans.push(key);
            }
        }
    }

    const details = {};
    if (dbMissing.length > 0) details.dbRefsNotOnDisk = dbMissing;
    if (diskOrphans.length > 0) details.diskOrphans = diskOrphans;

    return {
        name: 'Archive file cross-reference',
        type: dbMissing.length > 0 ? 'hard' : 'info',
        passed: dbMissing.length === 0,
        details: Object.keys(details).length > 0 ? details : null
    };
}

async function checkEmptyReactions(db) {
    const row = await db.get(`
        SELECT COUNT(*) as cnt FROM raw_archive
        WHERE json_extract(metadata, '$.reactions') = '[]'
    `);
    return {
        name: 'Empty reactions arrays',
        type: 'info',
        passed: true,
        details: { empty_reactions: row.cnt }
    };
}

async function checkMetadataDistribution(db) {
    const row = await db.get(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN metadata IS NULL THEN 1 ELSE 0 END) as null_metadata,
            SUM(CASE WHEN json_extract(metadata, '$.reactions') IS NOT NULL THEN 1 ELSE 0 END) as has_reactions,
            SUM(CASE WHEN json_extract(metadata, '$.reference') IS NOT NULL THEN 1 ELSE 0 END) as has_reference,
            SUM(CASE WHEN json_extract(metadata, '$.embeds') IS NOT NULL THEN 1 ELSE 0 END) as has_embeds,
            SUM(CASE WHEN json_extract(metadata, '$.type') IS NOT NULL THEN 1 ELSE 0 END) as has_type,
            SUM(CASE WHEN json_extract(metadata, '$.editedTimestamp') IS NOT NULL THEN 1 ELSE 0 END) as has_edited,
            SUM(CASE WHEN json_extract(metadata, '$.mentions') IS NOT NULL THEN 1 ELSE 0 END) as has_mentions,
            SUM(CASE WHEN json_extract(metadata, '$.webhookId') IS NOT NULL THEN 1 ELSE 0 END) as has_webhook,
            SUM(CASE WHEN json_extract(metadata, '$.position') IS NOT NULL THEN 1 ELSE 0 END) as has_position,
            SUM(CASE WHEN json_extract(metadata, '$.nonce') IS NOT NULL THEN 1 ELSE 0 END) as has_nonce
        FROM raw_archive
    `);
    return {
        name: 'Metadata key distribution',
        type: 'info',
        passed: true,
        details: row
    };
}

async function checkRowCounts(db) {
    const rows = await db.all(`
        SELECT channel_name, channel_id, COUNT(*) as db_rows, COUNT(DISTINCT archive_file) as files
        FROM raw_archive GROUP BY channel_id ORDER BY db_rows DESC
    `);
    return {
        name: 'Row counts per channel',
        type: 'info',
        passed: true,
        details: rows
    };
}

// ============ Snapshot Diffing ============

async function ensureSnapshotTable(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS audit_snapshots (
            snapshot_date TEXT,
            guild_id TEXT,
            channel_id TEXT,
            row_count INTEGER,
            min_timestamp INTEGER,
            max_timestamp INTEGER
        )
    `);
}

async function recordSnapshot(db, guildId) {
    const now = new Date().toISOString();
    const channels = await db.all(`
        SELECT channel_id, COUNT(*) as row_count,
               MIN(createdTimestamp) as min_timestamp,
               MAX(createdTimestamp) as max_timestamp
        FROM raw_archive GROUP BY channel_id
    `);

    for (const ch of channels) {
        await db.run(
            `INSERT INTO audit_snapshots (snapshot_date, guild_id, channel_id, row_count, min_timestamp, max_timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [now, guildId, ch.channel_id, ch.row_count, ch.min_timestamp, ch.max_timestamp]
        );
    }

    return now;
}

async function diffSnapshot(db, guildId) {
    // Get the two most recent snapshot dates
    const dates = await db.all(`
        SELECT DISTINCT snapshot_date FROM audit_snapshots
        WHERE guild_id = ? ORDER BY snapshot_date DESC LIMIT 2
    `, [guildId]);

    if (dates.length < 2) {
        return { name: 'Snapshot diff', type: 'info', passed: true, details: 'First snapshot — no previous to compare' };
    }

    const current = dates[0].snapshot_date;
    const previous = dates[1].snapshot_date;

    const regressions = await db.all(`
        SELECT
            c.channel_id,
            p.row_count as prev_rows,
            c.row_count as curr_rows,
            p.min_timestamp as prev_min_ts,
            c.min_timestamp as curr_min_ts,
            p.max_timestamp as prev_max_ts,
            c.max_timestamp as curr_max_ts
        FROM audit_snapshots c
        JOIN audit_snapshots p ON c.channel_id = p.channel_id AND p.guild_id = c.guild_id
        WHERE c.snapshot_date = ? AND p.snapshot_date = ? AND c.guild_id = ?
          AND (c.row_count < p.row_count
               OR c.min_timestamp != p.min_timestamp
               OR c.max_timestamp < p.max_timestamp)
    `, [current, previous, guildId]);

    return {
        name: 'Snapshot diff',
        type: regressions.length > 0 ? 'hard' : 'info',
        passed: regressions.length === 0,
        details: regressions.length > 0 ? regressions : { compared: previous + ' -> ' + current, regressions: 0 }
    };
}

// ============ Main ============

async function auditGuild(guildId) {
    const dbPath = path.join(__dirname, '..', 'Output', guildId, 'archive.db');
    if (!fs.existsSync(dbPath)) {
        console.log('  SKIP: No database found');
        return null;
    }

    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    const totalRows = (await db.get('SELECT COUNT(*) as cnt FROM raw_archive')).cnt;

    if (totalRows === 0) {
        console.log('  SKIP: 0 rows');
        await db.close();
        return null;
    }

    console.log('  Rows: ' + totalRows);

    const checks = [
        await checkNulls(db),
        await checkSnowflakes(db),
        await checkContentIntegrity(db),
        await checkTimestamps(db),
        await checkTimestampMonotonicity(db),
        await checkGuildConsistency(db, guildId),
        await checkChannelConsistency(db),
        await checkMetadataJson(db),
        await checkCoreFieldLeakage(db),
        await checkArchiveFilesOnDisk(db, guildId),
        await checkEmptyReactions(db),
        await checkMetadataDistribution(db),
        await checkRowCounts(db),
    ];

    // Record snapshot and diff
    await ensureSnapshotTable(db);
    await recordSnapshot(db, guildId);
    checks.push(await diffSnapshot(db, guildId));

    await db.close();
    return checks;
}

function printCheck(check, index) {
    const icon = check.type === 'info' ? 'i' : (check.passed ? 'ok' : 'FAIL');
    const label = '[' + icon + '] #' + (index + 1) + ' ' + check.name;
    console.log('  ' + label);

    if (!check.details) return;

    // Print details based on check type
    if (Array.isArray(check.details)) {
        for (const row of check.details) {
            const parts = Object.entries(row).map(([k, v]) => k + '=' + v);
            console.log('      ' + parts.join(', '));
        }
    } else if (typeof check.details === 'string') {
        console.log('      ' + check.details);
    } else if (typeof check.details === 'object') {
        // Special handling for different detail shapes
        if (check.details.renames || check.details.collisions) {
            if (check.details.renames) {
                console.log('      Channel renames (expected):');
                for (const r of check.details.renames) {
                    console.log('        ' + r.channel_id + ': ' + r.names);
                }
            }
            if (check.details.collisions) {
                console.log('      Same name, different channels:');
                for (const c of check.details.collisions) {
                    console.log('        "' + c.channel_name + '" -> IDs: ' + c.ids);
                }
            }
        } else if (check.details.dbRefsNotOnDisk || check.details.diskOrphans) {
            if (check.details.dbRefsNotOnDisk) {
                console.log('      DB refs not on disk (' + check.details.dbRefsNotOnDisk.length + '):');
                for (const f of check.details.dbRefsNotOnDisk.slice(0, 10)) {
                    console.log('        ' + f);
                }
                if (check.details.dbRefsNotOnDisk.length > 10) {
                    console.log('        ... and ' + (check.details.dbRefsNotOnDisk.length - 10) + ' more');
                }
            }
            if (check.details.diskOrphans) {
                console.log('      Orphaned files on disk (' + check.details.diskOrphans.length + '):');
                for (const f of check.details.diskOrphans.slice(0, 10)) {
                    console.log('        ' + f);
                }
                if (check.details.diskOrphans.length > 10) {
                    console.log('        ... and ' + (check.details.diskOrphans.length - 10) + ' more');
                }
            }
        } else if (check.details.total !== undefined) {
            // Metadata distribution
            const total = check.details.total;
            for (const [k, v] of Object.entries(check.details)) {
                if (k === 'total') {
                    console.log('      total: ' + v);
                } else {
                    const pct = total > 0 ? ' (' + (v / total * 100).toFixed(1) + '%)' : '';
                    console.log('      ' + k + ': ' + v + pct);
                }
            }
        } else if (check.details.compared !== undefined) {
            console.log('      ' + check.details.compared + ' — ' + check.details.regressions + ' regressions');
        } else {
            // Generic object
            for (const [k, v] of Object.entries(check.details)) {
                console.log('      ' + k + ': ' + v);
            }
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const guildIdx = args.indexOf('--guild');
    const guildIdArg = guildIdx !== -1 ? args[guildIdx + 1] : null;

    const outputPath = path.join(__dirname, '..', 'Output');
    if (!fs.existsSync(outputPath)) {
        console.error('Output directory not found');
        process.exit(1);
    }

    const guildIds = guildIdArg
        ? [guildIdArg]
        : fs.readdirSync(outputPath).filter(entry => {
            const fullPath = path.join(outputPath, entry);
            return fs.statSync(fullPath).isDirectory() && /^\d+$/.test(entry);
        });

    console.log('=== Archive Database Audit ===\n');

    let totalHardFails = 0;

    for (const guildId of guildIds) {
        console.log('Guild ' + guildId + ':');
        const checks = await auditGuild(guildId);
        if (!checks) continue;

        for (let i = 0; i < checks.length; i++) {
            printCheck(checks[i], i);
            if (checks[i].type === 'hard' && !checks[i].passed) {
                totalHardFails++;
            }
        }
        console.log('');
    }

    console.log('=== Audit Summary ===');
    if (totalHardFails === 0) {
        console.log('All hard checks PASSED.');
    } else {
        console.log('FAILED: ' + totalHardFails + ' hard check(s) failed.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
