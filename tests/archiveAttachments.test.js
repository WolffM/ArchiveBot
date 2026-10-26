/**
 * Attachments, end to end: a real HTTP server, the real filesystem and a real
 * archive.db under the per-file state root. Only the rate-limit sleep is
 * stubbed, so a run with a few attachments does not take seconds.
 */
jest.mock('../utils/helper', () => ({
    ...jest.requireActual('../utils/helper'),
    delay: () => Promise.resolve(),
}));

const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { downloadFile } = require('../utils/fileManager');
const archive = require('../lib/archive');
const { createMockMessage, createMockCollection } = require('./mocks/discord');

const BODIES = {
    '/a': Buffer.from('first image.png'),
    '/b': Buffer.from('second, different image.png'),
};

let server;
let base;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/truncated') {
            res.writeHead(200, { 'Content-Length': 100 });
            res.write('only part of it');
            res.destroy();
            return;
        }
        const body = BODIES[req.url];
        if (!body) {
            res.writeHead(404);
            res.end('<Error>expired</Error>');
            return;
        }
        res.writeHead(200);
        res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const dir = () => fs.mkdtempSync(path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, 'dl-'));

describe('downloadFile', () => {
    test('writes the body and returns its size', async () => {
        const target = path.join(dir(), 'f');
        await expect(downloadFile(`${base}/a`, target, BODIES['/a'].length)).resolves.toBe(BODIES['/a'].length);
        expect(fs.readFileSync(target)).toEqual(BODIES['/a']);
        expect(fs.existsSync(`${target}.part`)).toBe(false);
    });

    test('a non-200 is a failure, not a file', async () => {
        const target = path.join(dir(), 'f');
        await expect(downloadFile(`${base}/gone`, target)).rejects.toThrow(/HTTP 404/);
        expect(fs.readdirSync(path.dirname(target))).toEqual([]);
    });

    test('a size that disagrees with Discord is refused and leaves nothing behind', async () => {
        const target = path.join(dir(), 'f');
        await expect(downloadFile(`${base}/a`, target, 999)).rejects.toThrow(/expected 999 bytes/);
        expect(fs.readdirSync(path.dirname(target))).toEqual([]);
    });

    test('a cut connection does not replace an existing file', async () => {
        const target = path.join(dir(), 'f');
        fs.writeFileSync(target, 'the good copy');
        await expect(downloadFile(`${base}/truncated`, target, 100)).rejects.toThrow();
        expect(fs.readFileSync(target, 'utf8')).toBe('the good copy');
        expect(fs.existsSync(`${target}.part`)).toBe(false);
    });
});

describe('archiveChannel attachments', () => {
    function attachment(id, url, size) {
        return { id, name: 'image.png', url, size, contentType: 'image/png' };
    }

    test('two attachments with the same name are two files', async () => {
        const channel = {
            id: '1100000000000000001',
            name: 'memes',
            guild: { id: '1200000000000000001' },
        };
        const now = Date.now();
        const author = { id: '1500000000000000001', username: 'poster', globalName: 'Poster' };
        const messages = [
            createMockMessage({
                id: '1300000000000000002',
                createdTimestamp: now,
                author,
                channel,
                attachments: new Map([['1400000000000000002', attachment('1400000000000000002', `${base}/b`, BODIES['/b'].length)]]),
            }),
            createMockMessage({
                id: '1300000000000000001',
                createdTimestamp: now - 1000,
                author,
                channel,
                attachments: new Map([['1400000000000000001', attachment('1400000000000000001', `${base}/a`, BODIES['/a'].length)]]),
            }),
        ];
        let served = false;
        channel.messages = {
            fetch: jest.fn(async (opts) => {
                if (opts?.message || Array.isArray(opts) || !served) {
                    served = true;
                    return createMockCollection(messages.map((m) => [m.id, m]));
                }
                return createMockCollection();
            }),
        };

        await archive.archiveSingleChannel(channel);

        const folder = path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, channel.guild.id, `${channel.name}_${channel.id}`, 'attachments');
        expect(fs.readdirSync(folder).sort()).toEqual([
            '1400000000000000001_image.png',
            '1400000000000000002_image.png',
        ]);
        expect(fs.readFileSync(path.join(folder, '1400000000000000001_image.png'))).toEqual(BODIES['/a']);
        expect(fs.readFileSync(path.join(folder, '1400000000000000002_image.png'))).toEqual(BODIES['/b']);

        const db = await open({ filename: path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, channel.guild.id, 'archive.db'), driver: sqlite3.Database });
        const rows = await db.all('SELECT id FROM raw_archive ORDER BY id');
        await db.close();
        expect(rows.map((r) => r.id)).toEqual(['1300000000000000001', '1300000000000000002']);
    });

    test('a name cannot address outside the attachments folder', () => {
        expect(archive.attachmentFileName({ id: '1', name: '../../escape.png' })).toBe('1_escape.png');
    });
});
