/**
 * Repair a channel's attachments folder after the by-name era.
 *
 * Until 2026-10-25 attachments were saved as `attachments/<name>`, so every
 * later `image.png` in a channel overwrote the one before it. The archive JSON
 * still records every attachment (id, name, size), which is enough to work out
 * which id each surviving file belongs to and which attachments were lost.
 *
 * For each recorded attachment, in order of preference:
 *   ok       `<id>_<name>` already exists at the recorded size
 *   rename   the old by-name file is this attachment: its size matches, and no
 *            other attachment of that name has the same size
 *   recover  nothing on disk is it; re-download it while Discord still has it
 *
 * Files on disk that no recorded attachment claims (runs whose JSON is gone,
 * overwrites by those) are reported as `legacy` and never touched.
 */
const fs = require('fs');
const path = require('path');
const { attachmentFileName } = require('./archive');
const { downloadFile, delay } = require('../utils/helper');
const { outputPath } = require('./paths');
const { createLogger } = require('../utils/logger');

const log = createLogger('archiveRepair');

// Discord's limit per refresh-urls call.
const REFRESH_BATCH = 50;

const ARCHIVE_JSON = /^archive_\d+\.json$/;

/** Every attachment the channel's archive JSON records, one per id. */
function recordedAttachments(channelFolder) {
    const byId = new Map();
    const files = fs.readdirSync(channelFolder).filter((f) => ARCHIVE_JSON.test(f)).sort();
    for (const file of files) {
        const messages = JSON.parse(fs.readFileSync(path.join(channelFolder, file), 'utf8'));
        for (const message of messages) {
            for (const a of message.metadata?.attachments || []) {
                byId.set(a.id, { messageId: message.id, id: a.id, name: a.name, size: a.size, url: a.url, contentType: a.contentType || null });
            }
        }
    }
    return [...byId.values()];
}

function sizeOf(file) {
    try {
        return fs.statSync(file).size;
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function planChannel(channelFolder) {
    const dir = path.join(channelFolder, 'attachments');
    const recorded = recordedAttachments(channelFolder);
    const plan = { ok: [], rename: [], recover: [], legacy: [] };
    const claimed = new Set();

    const byName = new Map();
    for (const a of recorded) {
        if (!byName.has(a.name)) byName.set(a.name, []);
        byName.get(a.name).push(a);
    }

    for (const a of recorded) {
        const target = attachmentFileName(a);
        if (sizeOf(path.join(dir, target)) === a.size) {
            plan.ok.push(a);
            claimed.add(target);
            continue;
        }
        const old = path.basename(a.name);
        const oldSize = claimed.has(old) ? null : sizeOf(path.join(dir, old));
        const sameSize = (byName.get(a.name) || []).filter((b) => b.size === oldSize);
        if (oldSize === a.size && sameSize.length === 1) {
            plan.rename.push({ ...a, from: old, to: target });
            claimed.add(old);
        } else {
            plan.recover.push(a);
        }
    }

    if (fs.existsSync(dir)) {
        const targets = new Set(recorded.map(attachmentFileName));
        for (const f of fs.readdirSync(dir)) {
            if (!claimed.has(f) && !targets.has(f)) plan.legacy.push(f);
        }
    }
    return plan;
}

/** Apply the renames. Never overwrites: a target that appeared since planning is left alone. */
function applyRenames(channelFolder, plan) {
    const dir = path.join(channelFolder, 'attachments');
    let renamed = 0;
    for (const r of plan.rename) {
        const to = path.join(dir, r.to);
        if (fs.existsSync(to)) continue;
        fs.renameSync(path.join(dir, r.from), to);
        renamed++;
    }
    return renamed;
}

/** The attachment id in a Discord CDN URL: `/attachments/<channel>/<id>/<name>`. */
function attachmentIdOf(url) {
    const m = /\/attachments\/\d+\/(\d+)\//.exec(url || '');
    return m ? m[1] : null;
}

/**
 * Re-download what the plan could not find on disk.
 *
 * The recorded URLs are signed and long expired; `POST /attachments/refresh-urls`
 * re-signs up to 50 at a time without fetching each message. An attachment whose
 * message is gone comes back as a 404 and counts as `gone`: that one is lost.
 */
async function recoverAttachments(rest, channelFolder, plan, { pause = 250 } = {}) {
    const dir = path.join(channelFolder, 'attachments');
    if (plan.recover.length > 0) fs.mkdirSync(dir, { recursive: true });
    const result = { recovered: 0, gone: 0, failed: 0 };
    for (let i = 0; i < plan.recover.length; i += REFRESH_BATCH) {
        const batch = plan.recover.slice(i, i + REFRESH_BATCH);
        let refreshed;
        try {
            const resp = await rest.post('/attachments/refresh-urls', {
                body: { attachment_urls: batch.map((a) => a.url) },
            });
            refreshed = new Map((resp.refreshed_urls || []).map((r) => [attachmentIdOf(r.original), r.refreshed]));
        } catch (err) {
            log.error('refresh_urls', err, { channelFolder: path.basename(channelFolder), batch: batch.length });
            result.failed += batch.length;
            continue;
        }
        for (const a of batch) {
            const url = refreshed.get(a.id);
            if (!url) {
                result.gone++;
                continue;
            }
            try {
                await downloadFile(url, path.join(dir, attachmentFileName(a)), a.size);
                result.recovered++;
            } catch (err) {
                if (/HTTP 404|HTTP 403/.test(err.message)) result.gone++;
                else {
                    result.failed++;
                    log.warn('recoverAttachments', { attachmentId: a.id, error: err.message });
                }
            }
            await delay(pause);
        }
    }
    return result;
}

/** Channel folders of one guild: `<name>_<id>` directories. */
function channelFolders(guildId) {
    const guildDir = outputPath(guildId);
    if (!fs.existsSync(guildDir)) return [];
    return fs.readdirSync(guildDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /_\d+$/.test(e.name))
        .map((e) => path.join(guildDir, e.name));
}

/**
 * Plan every channel of a guild and, with `apply`, rename and recover.
 * Without `apply` it only reads, so it is safe to run any time. One applying
 * run per guild at a time: two would race on the same renames.
 */
const running = new Set();

function isRunning(guildId) {
    return running.has(guildId);
}

async function repairGuild(guildId, { rest, apply = false, pause } = {}) {
    if (!apply) return repairGuildOnce(guildId, { rest, apply, pause });
    if (running.has(guildId)) throw new Error(`a repair is already running for guild ${guildId}`);
    running.add(guildId);
    try {
        return await repairGuildOnce(guildId, { rest, apply, pause });
    } finally {
        running.delete(guildId);
    }
}

function summarize(t, apply) {
    const lines = [
        `${t.channels} channels: ${t.ok} fine, ${t.rename} to rename, ${t.recover} to recover, ${t.legacy} unrecorded (kept as-is).`,
    ];
    if (apply) lines.push(`Renamed ${t.renamed}, recovered ${t.recovered}, gone from Discord ${t.gone}, failed ${t.failed}.`);
    else lines.push('Nothing changed. Run with apply:true to repair.');
    return lines.join('\n');
}

async function repairGuildOnce(guildId, { rest, apply, pause }) {
    const totals = { channels: 0, ok: 0, rename: 0, recover: 0, legacy: 0, renamed: 0, recovered: 0, gone: 0, failed: 0 };
    for (const folder of channelFolders(guildId)) {
        const plan = planChannel(folder);
        totals.channels++;
        for (const k of ['ok', 'rename', 'recover', 'legacy']) totals[k] += plan[k].length;
        if (!apply) continue;
        totals.renamed += applyRenames(folder, plan);
        const r = await recoverAttachments(rest, folder, plan, { pause });
        totals.recovered += r.recovered;
        totals.gone += r.gone;
        totals.failed += r.failed;
        log.info('repairChannel', { guildId, channel: path.basename(folder), ...r, renamed: plan.rename.length });
    }
    log.success('repairGuild', { guildId, apply, ...totals });
    return totals;
}

module.exports = { recordedAttachments, planChannel, applyRenames, recoverAttachments, repairGuild, isRunning, summarize, attachmentIdOf };
