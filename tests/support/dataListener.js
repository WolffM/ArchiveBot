/**
 * Start dataplatform's REAL data listener on a scratch store for a test file.
 * See scratch_data_listener.py. Needs the dataplatform checkout and its venv
 * (DATAPLATFORM_SERVER, default ~/srv/hadoku-dataplatform/server); missing,
 * the suite fails rather than skips.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = process.env.DATAPLATFORM_SERVER || path.join(os.homedir(), 'srv', 'hadoku-dataplatform', 'server');
const KEY = 'test-archivebot-key';
const OTHER_KEY = 'test-unbound-key';

/** `parent`: where the scratch store goes; /tmp is a small tmpfs on hokon. */
async function startDataListener({ parent = os.tmpdir() } = {}) {
    const root = fs.mkdtempSync(path.join(parent, 'archivebot-datastore-'));
    const proc = spawn(path.join(SERVER_DIR, '.venv', 'bin', 'python'),
        ['-I', path.join(__dirname, 'scratch_data_listener.py'), root, 'u-archivebot'], {
            cwd: root,
            env: {
                PATH: process.env.PATH,
                WHOAMI_TEST_OVERRIDES: JSON.stringify({
                    [KEY]: { tier: 'service', userId: 'u-archivebot', name: 'archivebot-service-key' },
                    [OTHER_KEY]: { tier: 'service', userId: 'u-other', name: 'other-service-key' },
                }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    const port = await new Promise((resolve, reject) => {
        proc.stdout.once('data', (d) => resolve(Number(String(d).trim())));
        proc.once('exit', (code) => reject(new Error(`listener exited ${code}: ${stderr}`)));
    });
    return {
        url: `http://127.0.0.1:${port}`,
        root,
        stop() {
            proc.kill();
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

module.exports = { startDataListener, KEY, OTHER_KEY };
