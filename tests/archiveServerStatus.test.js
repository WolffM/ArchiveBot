/**
 * archiveServer with no status channel, or one it can no longer post to, still
 * archives; and the retired archive_server action no longer starts a run.
 * Real archive.js and SQLite, against the per-file state root.
 */
const fs = require('fs');
const archive = require('../lib/archive');
const { outputPath } = require('../lib/paths');
const { createMockCollection } = require('./mocks/discord');

const GUILD = '1442248915599753339';

function textChannel(id, name) {
    return {
        id, name, type: 0,
        messages: { fetch: jest.fn().mockResolvedValue(createMockCollection()) },
    };
}

function guild() {
    const channels = [textChannel('1442248916000000001', 'general'), textChannel('1442248916000000002', 'news')];
    const g = { id: GUILD, name: 'hadoku.me', channels: { cache: createMockCollection(channels.map(c => [c.id, c])) } };
    channels.forEach(c => { c.guild = g; });
    return g;
}

afterAll(() => fs.rmSync(outputPath(GUILD), { recursive: true, force: true }));

test('with no status channel it archives every channel and posts nothing', async () => {
    const result = await archive.archiveServer(guild(), null);
    expect(result).toEqual({ total: 2, archived: 0, skipped: 2, errors: 0 });
});

test('a status channel that refuses a post stops the posting, not the archive', async () => {
    const status = { id: 'status', send: jest.fn().mockRejectedValue(new Error('Missing Access')) };
    const g = guild();

    const result = await archive.archiveServer(g, status);

    expect(result.skipped).toBe(2);
    expect(status.send).toHaveBeenCalledTimes(1);
    for (const ch of g.channels.cache.values()) expect(ch.messages.fetch).toHaveBeenCalled();
});

test('a reminder still carrying archive_server does not start a run', async () => {
    const channel = { id: 'c', guild: guild(), send: jest.fn() };
    await archive.executeAction('archive_server', channel);
    expect(channel.send).not.toHaveBeenCalled();
});
