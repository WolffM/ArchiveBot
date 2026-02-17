/**
 * Database Backfill Script
 *
 * Re-processes ALL existing JSON archives into the SQLite database.
 * Handles 30+ different JSON schemas from different code versions.
 * Validates each row before insertion.
 * Idempotent — safe to re-run (uses INSERT OR REPLACE).
 *
 * Usage:
 *   node scripts/backfill-database.js                  # All guilds
 *   node scripts/backfill-database.js --guild 12345    # Specific guild
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { createLogger } = require('../utils/logger');
const archive = require('../lib/archive');

const log = createLogger('backfill');

async function backfillGuild(guildId) {
    const guildPath = path.join(__dirname, '..', 'Output', guildId);

    if (!fs.existsSync(guildPath)) {
        log.warn('backfillGuild', { guildId, reason: 'Guild directory not found' });
        return null;
    }

    // Ensure DB exists with new schema (migrates old schema if needed)
    await archive.initializeDatabaseIfNeeded(guildId);

    const dbPath = path.join(guildPath, 'archive.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    // Verify schema before proceeding
    const columns = await db.all('PRAGMA table_info(raw_archive)');
    const colNames = columns.map(c => c.name);
    const requiredCols = ['id', 'createdTimestamp', 'content', 'author_id', 'guild_id', 'channel_id', 'channel_name', 'archive_file', 'metadata'];
    const missingCols = requiredCols.filter(c => !colNames.includes(c));
    if (missingCols.length > 0) {
        log.error('backfillGuild', new Error('Schema validation failed'), {
            guildId,
            missingColumns: missingCols,
            actualColumns: colNames
        });
        await db.close();
        return null;
    }

    const countBefore = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');

    // Find all channel directories
    const entries = fs.readdirSync(guildPath).filter(entry => {
        const fullPath = path.join(guildPath, entry);
        return fs.statSync(fullPath).isDirectory() && entry !== 'attachments';
    });

    let totalInserted = 0;
    let totalSkipped = 0;
    let totalInvalid = 0;
    let channelsProcessed = 0;
    let channelErrors = 0;

    for (const channelDir of entries) {
        const channelPath = path.join(guildPath, channelDir);

        // Check if this directory has archive files
        const archiveFiles = fs.readdirSync(channelPath)
            .filter(f => f.startsWith('archive_') && f.endsWith('.json'));

        if (archiveFiles.length === 0) continue;

        try {
            const result = await archive.processNewArchiveFiles(db, guildId, channelPath);
            if (result) {
                totalInserted += result.inserted;
                totalSkipped += result.skipped;
                totalInvalid += result.invalid;
            }
            channelsProcessed++;
        } catch (error) {
            channelErrors++;
            log.error('backfillGuild', error, { guildId, channelDir });
        }
    }

    // Final counts
    const countAfter = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
    const withMeta = await db.get('SELECT COUNT(*) as cnt FROM raw_archive WHERE metadata IS NOT NULL');
    const channelCount = await db.get('SELECT COUNT(DISTINCT channel_name) as cnt FROM raw_archive');

    // Spot-check: sample a few rows to verify metadata is valid JSON
    const sampleRows = await db.all('SELECT id, metadata FROM raw_archive WHERE metadata IS NOT NULL ORDER BY RANDOM() LIMIT 5');
    let metadataParseErrors = 0;
    for (const row of sampleRows) {
        try {
            JSON.parse(row.metadata);
        } catch (e) {
            metadataParseErrors++;
            log.error('backfillGuild', e, { guildId, msgId: row.id, reason: 'metadata is not valid JSON' });
        }
    }

    await db.close();

    const summary = {
        guildId,
        rowsBefore: countBefore.cnt,
        rowsAfter: countAfter.cnt,
        newRowsInserted: countAfter.cnt - countBefore.cnt,
        channelsProcessed,
        channelErrors,
        messagesInserted: totalInserted,
        messagesSkippedNoAuthor: totalSkipped,
        messagesInvalid: totalInvalid,
        rowsWithMetadata: withMeta.cnt,
        distinctChannels: channelCount.cnt,
        metadataSpotCheckErrors: metadataParseErrors
    };

    log.success('backfillGuild', summary);

    console.log(`\n  Guild ${guildId}:`);
    console.log(`    DB rows before:        ${summary.rowsBefore}`);
    console.log(`    DB rows after:         ${summary.rowsAfter}`);
    console.log(`    New rows inserted:     ${summary.newRowsInserted}`);
    console.log(`    Channels processed:    ${summary.channelsProcessed}`);
    console.log(`    Channel errors:        ${summary.channelErrors}`);
    console.log(`    Messages inserted:     ${summary.messagesInserted}`);
    console.log(`    Skipped (no author):   ${summary.messagesSkippedNoAuthor}`);
    console.log(`    Invalid (failed val):  ${summary.messagesInvalid}`);
    console.log(`    Rows with metadata:    ${summary.rowsWithMetadata}`);
    console.log(`    Distinct channels:     ${summary.distinctChannels}`);
    if (metadataParseErrors > 0) {
        console.log(`    METADATA ERRORS:       ${metadataParseErrors} (spot-check failed!)`);
    }

    return summary;
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

    console.log('=== Archive Database Backfill ===');
    console.log(`Guilds to process: ${guildIds.join(', ')}\n`);

    const startTime = Date.now();
    const results = [];

    for (const guildId of guildIds) {
        console.log(`Processing guild ${guildId}...`);
        const result = await backfillGuild(guildId);
        if (result) results.push(result);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalRows = results.reduce((sum, r) => sum + r.rowsAfter, 0);
    const totalInvalid = results.reduce((sum, r) => sum + r.messagesInvalid, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.channelErrors, 0);

    console.log(`\n=== Backfill Complete (${elapsed}s) ===`);
    console.log(`  Total rows across all guilds: ${totalRows}`);
    if (totalInvalid > 0) console.log(`  Total invalid messages: ${totalInvalid}`);
    if (totalErrors > 0) console.log(`  Total channel errors: ${totalErrors}`);
}

main().catch(err => {
    log.error('backfill', err);
    console.error('Fatal error:', err);
    process.exit(1);
});
