#!/usr/bin/env node
/**
 * Delete local attachment files the data endpoint provably holds.
 *
 *   node scripts/prune-imported.js           # dry run: what would go, and why anything stays
 *   node scripts/prune-imported.js --apply
 *
 * A file goes only when ALL of these hold:
 * - the import manifest (Output/import/manifest.jsonl, written by the bot) has
 *   it as uploaded/same/skipped, with the sha256 the STORE reported;
 * - it is an attachment or legacy file (batch JSON and archive.db are the
 *   local cache and stay);
 * - re-hashing it now gives that same sha256.
 *
 * Nothing here talks to the store: it needs no key, and it trusts only what
 * the store itself answered during the import.
 */
const fs = require('fs');
const path = require('path');
const { sha256File } = require('../lib/dataStore');
const { loadManifest, manifestPath } = require('../lib/archiveImport');

const apply = process.argv.includes('--apply');
const VERIFIED = new Set(['uploaded', 'same', 'skipped']);
const PRUNABLE = /\/(attachments|legacy)\//;

(async () => {
    if (!fs.existsSync(manifestPath())) {
        console.error(`no manifest at ${manifestPath()}: the import has not run`);
        process.exit(1);
    }
    const stats = { deleted: 0, wouldDelete: 0, bytes: 0, kept: {} };
    const keep = (why) => { stats.kept[why] = (stats.kept[why] || 0) + 1; };

    for (const entry of loadManifest().values()) {
        if (!PRUNABLE.test(entry.key) || !entry.file) continue;
        if (!VERIFIED.has(entry.status)) { keep(entry.status); continue; }
        const storeSha = entry.storeSha256 || null;
        if (!storeSha || storeSha !== entry.sha256) { keep('no store-confirmed hash'); continue; }
        if (!fs.existsSync(entry.file)) { keep('already gone'); continue; }
        if (await sha256File(entry.file) !== storeSha) { keep('changed since import'); continue; }
        const size = fs.statSync(entry.file).size;
        if (apply) {
            fs.unlinkSync(entry.file);
            stats.deleted++;
        } else {
            stats.wouldDelete++;
        }
        stats.bytes += size;
    }

    // Empty attachments/ folders go too; nothing else is touched.
    if (apply) {
        for (const entry of loadManifest().values()) {
            if (!entry.file || !PRUNABLE.test(entry.key)) continue;
            const dir = path.dirname(entry.file);
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        }
    }
    console.log(JSON.stringify({ apply, ...stats, gb: (stats.bytes / 1e9).toFixed(2) }, null, 2));
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
