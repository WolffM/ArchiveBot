/**
 * archive.js mirrors log.csv lines into the data endpoint, but only onto a copy
 * the import already seeded. Its own file: the store client is module state,
 * created from the environment on first use.
 */
const { DataStore } = require('../lib/dataStore');
const { startDataListener, KEY } = require('./support/dataListener');

let listener;
let ds;
beforeAll(async () => {
    listener = await startDataListener();
    process.env.HADOKU_DATA_URL = listener.url;
    process.env.HADOKU_SERVICE_KEY = KEY;
    ds = new DataStore({ url: listener.url, key: KEY, ns: 'archivebot' });
}, 20000);
afterAll(() => {
    delete process.env.HADOKU_DATA_URL;
    delete process.env.HADOKU_SERVICE_KEY;
    ds.close();
    listener.stop();
});

const { appendStoreLog } = require('../lib/archive');

test('before the import seeds log.csv, nothing is appended', async () => {
    await appendStoreLog('archive,1,2,3\n');
    expect(await ds.head('log.csv')).toBeNull();
});

test('once seeded, each line is appended', async () => {
    await ds.put('log.csv', 'Task,GuildId,ChannelID,Timestamp\nold\n', { createOnly: true });
    await appendStoreLog('archive,1,2,3\n');
    expect((await ds.get('log.csv')).body.toString()).toBe('Task,GuildId,ChannelID,Timestamp\nold\narchive,1,2,3\n');
});
