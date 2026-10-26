const fs = require('fs');
const path = require('path');

/**
 * The one root every piece of bot output hangs off: archives, attachments,
 * scheduler state, sent-message records, spaces, the cardtable binding, the
 * tasklist and log.csv.
 *
 * `ARCHIVEBOT_OUTPUT_DIR` overrides it; unset, it is `Output/` in the checkout.
 * Read at require time on purpose: these are module-level paths, and a value
 * that could change under a running bot would be worse than one that cannot.
 */
const DEFAULT_ROOT = path.join(__dirname, '..', 'Output');
const OUTPUT_ROOT = process.env.ARCHIVEBOT_OUTPUT_DIR || DEFAULT_ROOT;

function outputPath(...parts) {
    return path.join(OUTPUT_ROOT, ...parts);
}

/**
 * Refuse to run against a configured root that does not exist.
 *
 * A configured root is a mount, not something to create: with its disk
 * missing, the mount point is an empty directory on `/`, and the first
 * `mkdirSync(recursive)` would quietly rebuild a fresh, empty Output there —
 * every reminder gone and the archive restarting from nothing. The default
 * root lives in the checkout and is still created on demand.
 */
function assertOutputRoot() {
    if (OUTPUT_ROOT === DEFAULT_ROOT) return;
    if (!fs.existsSync(OUTPUT_ROOT) || !fs.statSync(OUTPUT_ROOT).isDirectory()) {
        throw new Error(`ARCHIVEBOT_OUTPUT_DIR=${OUTPUT_ROOT} does not exist; refusing to create it`);
    }
}

module.exports = { OUTPUT_ROOT, outputPath, assertOutputRoot };
