/**
 * Database Backfill Script
 *
 * Re-processes ALL existing JSON archives into the SQLite database.
 * Handles 30+ different JSON schemas from different code versions.
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
        return;
    }

    // Ensure DB exists with new schema (migrates old schema if needed)
    await archive.initializeDatabaseIfNeeded(guildId);

    const dbPath = path.join(guildPath, 'archive.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    // Find all channel directories (folders containing archive_*.json files)
    const entries = fs.readdirSync(guildPath).filter(entry => {
        const fullPath = path.join(guildPath, entry);
        return fs.statSync(fullPath).isDirectory() && entry !== 'attachments';
    });

    let totalFiles = 0;
    let channelsProcessed = 0;

    for (const channelDir of entries) {
        const channelPath = path.join(guildPath, channelDir);

        // Check if this directory has archive files
        const archiveFiles = fs.readdirSync(channelPath)
            .filter(f => f.startsWith('archive_') && f.endsWith('.json'));

        if (archiveFiles.length === 0) continue;

        try {
            await archive.processNewArchiveFiles(db, guildId, channelPath);
            totalFiles += archiveFiles.length;
            channelsProcessed++;
            log.info('backfillGuild', {
                guildId,
                channel: channelDir,
                files: archiveFiles.length
            });
        } catch (error) {
            log.error('backfillGuild', error, { guildId, channelDir });
        }
    }

    // Report results
    const count = await db.get('SELECT COUNT(*) as cnt FROM raw_archive');
    const withMeta = await db.get('SELECT COUNT(*) as cnt FROM raw_archive WHERE metadata IS NOT NULL');

    log.success('backfillGuild', {
        guildId,
        channelsProcessed,
        filesProcessed: totalFiles,
        totalRowsInDB: count.cnt,
        rowsWithMetadata: withMeta.cnt
    });

    console.log(`\n  Guild ${guildId}:`);
    console.log(`    Channels processed: ${channelsProcessed}`);
    console.log(`    Archive files: ${totalFiles}`);
    console.log(`    Total DB rows: ${count.cnt}`);
    console.log(`    Rows with metadata: ${withMeta.cnt}`);

    await db.close();
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

    for (const guildId of guildIds) {
        console.log(`Processing guild ${guildId}...`);
        await backfillGuild(guildId);
    }

    console.log('\n=== Backfill Complete ===');
}

main().catch(err => {
    log.error('backfill', err);
    console.error('Fatal error:', err);
    process.exit(1);
});
