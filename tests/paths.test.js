const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/paths reads ARCHIVEBOT_OUTPUT_DIR at require time, so each case loads a
// fresh copy under the environment it describes.
function loadPaths(env) {
    const saved = process.env.ARCHIVEBOT_OUTPUT_DIR;
    if (env === undefined) delete process.env.ARCHIVEBOT_OUTPUT_DIR;
    else process.env.ARCHIVEBOT_OUTPUT_DIR = env;
    let mod;
    jest.isolateModules(() => { mod = require('../lib/paths'); });
    process.env.ARCHIVEBOT_OUTPUT_DIR = saved;
    return mod;
}

describe('the output root', () => {
    test('defaults to Output/ in the checkout', () => {
        const paths = loadPaths(undefined);
        expect(paths.OUTPUT_ROOT).toBe(path.join(__dirname, '..', 'Output'));
        expect(() => paths.assertOutputRoot()).not.toThrow();
    });

    test('ARCHIVEBOT_OUTPUT_DIR moves every path under it', () => {
        const paths = loadPaths('/mnt/somewhere/archivebot');
        expect(paths.OUTPUT_ROOT).toBe('/mnt/somewhere/archivebot');
        expect(paths.outputPath('123', 'archive.db')).toBe('/mnt/somewhere/archivebot/123/archive.db');
        expect(paths.outputPath('log.csv')).toBe('/mnt/somewhere/archivebot/log.csv');
    });

    test('a configured root that exists passes the guard', () => {
        const paths = loadPaths(process.env.ARCHIVEBOT_OUTPUT_DIR);
        expect(() => paths.assertOutputRoot()).not.toThrow();
    });

    test('a configured root that is missing is refused, not created', () => {
        const missing = path.join(os.tmpdir(), `archivebot-unmounted-${process.pid}`, 'Output');
        const paths = loadPaths(missing);
        expect(() => paths.assertOutputRoot()).toThrow(/does not exist; refusing to create it/);
        expect(fs.existsSync(missing)).toBe(false);
    });

    test('a configured root that is a file is refused', () => {
        const file = path.join(process.env.ARCHIVEBOT_OUTPUT_DIR, 'not-a-dir');
        fs.writeFileSync(file, '');
        const paths = loadPaths(file);
        expect(() => paths.assertOutputRoot()).toThrow(/refusing to create it/);
    });
});

describe('every store resolves under the configured root', () => {
    const root = () => process.env.ARCHIVEBOT_OUTPUT_DIR;

    test('scheduler, spaces, cardtable and tasklist', () => {
        require('../lib/scheduler').saveScheduledItems('g1', { items: [] });
        expect(fs.existsSync(path.join(root(), 'g1', 'scheduled.json'))).toBe(true);
        require('../lib/cardtableStore').saveSetup('g2', { invite: 'x' });
        expect(fs.existsSync(path.join(root(), 'g2', 'cardtable.json'))).toBe(true);
        expect(require('../lib/meetingSpaceStore').getSpacesFilePath('g1'))
            .toBe(path.join(root(), 'g1', 'spaces.json'));
        expect(require('../utils/users').getGuildPath('g1'))
            .toBe(path.join(root(), 'tasklist', 'g1'));
    });
});
