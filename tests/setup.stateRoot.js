/**
 * Give every test FILE its own on-disk state root.
 *
 * The meeting-space store keeps one directory per guild and the sweep and
 * repair passes walk all of them — by design, since the bot must not skip a
 * guild. Under a shared root that made the suites interfere: a test seeding one
 * guild saw every guild any earlier file had written, so a cross-guild count
 * like `skippedActive` came back 3 instead of 1 and the failure moved around
 * with jest's file ordering.
 *
 * Per file rather than per worker: jest reuses a worker for several files, so a
 * worker-scoped directory would leak in exactly the same way, just less often.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivebot-state-'));
process.env.ARCHIVEBOT_OUTPUT_DIR = root;

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});
