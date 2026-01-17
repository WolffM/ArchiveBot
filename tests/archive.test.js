/**
 * Unit tests for archive.js
 * Tests data transformation functions
 */

// Mock native modules FIRST before any requires
jest.mock('sqlite3', () => ({
    verbose: () => ({
        Database: jest.fn()
    })
}));
jest.mock('sqlite', () => ({
    open: jest.fn()
}));

// Mock other dependencies
jest.mock('fs');
jest.mock('axios');
jest.mock('csv-writer', () => ({
    createObjectCsvWriter: jest.fn(() => ({
        writeRecords: jest.fn()
    }))
}));
jest.mock('../utils/helper', () => ({
    ensureDirectoryExists: jest.fn(),
    loadJsonFile: jest.fn(),
    saveJsonFile: jest.fn(),
    downloadFile: jest.fn(),
    scrubEmptyFields: jest.fn(obj => obj),
    delay: jest.fn().mockResolvedValue(undefined),
    logProgress: jest.fn()
}));

const fs = require('fs');
const { createMockMessage } = require('./mocks/discord');
const archive = require('../lib/archive');

describe('archive.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('scrubMessages', () => {
        test('extracts basic message fields', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-123',
                    content: 'Hello world',
                    createdTimestamp: 1234567890
                })
            ];

            const result = archive.scrubMessages(messages);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('msg-123');
            expect(result[0].content).toBe('Hello world');
            expect(result[0].createdTimestamp).toBe(1234567890);
        });

        test('handles message with reactions array', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-456',
                    reactions: [
                        { emoji: '👍', count: 5, users: ['u1', 'u2'] },
                        { emoji: '❤️', count: 3, users: ['u3'] }
                    ]
                })
            ];

            const result = archive.scrubMessages(messages);

            expect(result[0].reactions).toHaveLength(2);
            expect(result[0].reactions[0].emoji).toBe('👍');
            expect(result[0].reactions[0].count).toBe(5);
        });

        test('handles message with reference (reply)', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-789',
                    reference: {
                        messageId: 'original-msg',
                        channelId: 'channel-1',
                        guildId: 'guild-1'
                    }
                })
            ];

            const result = archive.scrubMessages(messages);

            expect(result[0].reference).toBeDefined();
            expect(result[0].reference.messageId).toBe('original-msg');
            expect(result[0].reference.channelId).toBe('channel-1');
        });

        test('handles message without reactions', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-simple',
                    reactions: undefined
                })
            ];

            const result = archive.scrubMessages(messages);

            expect(result[0].reactions).toBeUndefined();
        });

        test('handles message without reference', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-noreply',
                    reference: null
                })
            ];

            const result = archive.scrubMessages(messages);

            expect(result[0].reference).toBeUndefined();
        });

        test('handles empty messages array', () => {
            const result = archive.scrubMessages([]);
            expect(result).toEqual([]);
        });

        test('handles multiple messages', () => {
            const messages = [
                createMockMessage({ id: 'msg-1', content: 'First' }),
                createMockMessage({ id: 'msg-2', content: 'Second' }),
                createMockMessage({ id: 'msg-3', content: 'Third' })
            ];

            const result = archive.scrubMessages(messages);

            expect(result).toHaveLength(3);
            expect(result.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
        });
    });

    describe('createAuthorsMap', () => {
        test('groups messages by author', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-1',
                    author: { id: 'user-1', username: 'Alice', globalName: 'Alice A' }
                }),
                createMockMessage({
                    id: 'msg-2',
                    author: { id: 'user-1', username: 'Alice', globalName: 'Alice A' }
                }),
                createMockMessage({
                    id: 'msg-3',
                    author: { id: 'user-2', username: 'Bob', globalName: 'Bob B' }
                })
            ];

            const result = archive.createAuthorsMap(messages);

            expect(Object.keys(result)).toHaveLength(2);
            expect(result['user-1'].msgIds).toEqual(['msg-1', 'msg-2']);
            expect(result['user-2'].msgIds).toEqual(['msg-3']);
        });

        test('includes author metadata', () => {
            const messages = [
                createMockMessage({
                    id: 'msg-1',
                    author: {
                        id: 'user-123',
                        username: 'TestUser',
                        globalName: 'Test User Global'
                    }
                })
            ];

            const result = archive.createAuthorsMap(messages);

            expect(result['user-123'].id).toBe('user-123');
            expect(result['user-123'].username).toBe('TestUser');
            expect(result['user-123'].globalName).toBe('Test User Global');
        });

        test('handles single author with multiple messages', () => {
            const messages = [
                createMockMessage({ id: 'msg-1', author: { id: 'user-1', username: 'Solo' } }),
                createMockMessage({ id: 'msg-2', author: { id: 'user-1', username: 'Solo' } }),
                createMockMessage({ id: 'msg-3', author: { id: 'user-1', username: 'Solo' } })
            ];

            const result = archive.createAuthorsMap(messages);

            expect(Object.keys(result)).toHaveLength(1);
            expect(result['user-1'].msgIds).toHaveLength(3);
        });

        test('handles empty messages array', () => {
            const result = archive.createAuthorsMap([]);
            expect(result).toEqual({});
        });
    });

    describe('getLastArchiveTime', () => {
        test('returns 0 when no log file exists', async () => {
            fs.existsSync.mockReturnValue(false);

            const result = await archive.getLastArchiveTime('guild-1', 'channel-1');

            expect(result).toBe(0);
        });

        test('returns most recent timestamp for channel', async () => {
            const logContent = `Task,GuildId,ChannelID,Timestamp
archive,guild-1,channel-1,1000000
archive,guild-1,channel-1,2000000
archive,guild-1,channel-2,3000000`;

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(logContent);

            const result = await archive.getLastArchiveTime('guild-1', 'channel-1');

            expect(result).toBe(2000000);
        });

        test('ignores entries for other channels', async () => {
            const logContent = `Task,GuildId,ChannelID,Timestamp
archive,guild-1,channel-other,5000000
archive,guild-1,channel-1,1000000`;

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(logContent);

            const result = await archive.getLastArchiveTime('guild-1', 'channel-1');

            expect(result).toBe(1000000);
        });

        test('resets future timestamps to 0', async () => {
            const futureTime = Date.now() + 1000000000;
            const logContent = `Task,GuildId,ChannelID,Timestamp
archive,guild-1,channel-1,${futureTime}`;

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(logContent);

            const result = await archive.getLastArchiveTime('guild-1', 'channel-1');

            expect(result).toBe(0);
        });

        test('returns 0 for empty log file', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('Task,GuildId,ChannelID,Timestamp\n');

            const result = await archive.getLastArchiveTime('guild-1', 'channel-1');

            expect(result).toBe(0);
        });
    });
});
