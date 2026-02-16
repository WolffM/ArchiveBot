/**
 * Unit tests for archive.js
 * Tests data transformation functions and database operations
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
const { createMockMessage, createMockCollection } = require('./mocks/discord');
const archive = require('../lib/archive');

describe('archive.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ========================================================
    // scrubMessages — core field extraction
    // ========================================================

    describe('scrubMessages - core fields', () => {
        test('extracts id, createdTimestamp, content at top level', () => {
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

        test('handles empty messages array', () => {
            const result = archive.scrubMessages([]);
            expect(result).toEqual([]);
        });

        test('handles multiple messages preserving order', () => {
            const messages = [
                createMockMessage({ id: 'msg-1', content: 'First' }),
                createMockMessage({ id: 'msg-2', content: 'Second' }),
                createMockMessage({ id: 'msg-3', content: 'Third' })
            ];

            const result = archive.scrubMessages(messages);

            expect(result).toHaveLength(3);
            expect(result.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
        });

        test('omits metadata key entirely when message has no extra data', () => {
            const messages = [createMockMessage({
                id: 'msg-bare',
                type: 0,
                reactions: { cache: new Map() }, // Discord.js default, not an array
                reference: null,
                attachments: new Map(),
                embeds: [],
                mentions: { users: new Map(), roles: new Map(), everyone: false, repliedUser: null },
                editedTimestamp: null,
                flags: { bitfield: 0 },
                pinned: false,
                system: false,
                webhookId: null,
                applicationId: null,
                interaction: null,
                interactionMetadata: null,
                position: null,
                nonce: null
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0]).toEqual({
                id: 'msg-bare',
                createdTimestamp: expect.any(Number),
                content: 'Test message content'
            });
            expect(result[0].metadata).toBeUndefined();
        });
    });

    // ========================================================
    // scrubMessages — metadata capture
    // ========================================================

    describe('scrubMessages - metadata', () => {
        test('captures reactions with emoji object (name, id, animated)', () => {
            const messages = [createMockMessage({
                id: 'msg-react',
                reactions: [
                    { emoji: { name: 'pepe', id: '123456789', animated: false }, count: 2, users: ['u1', 'u2'] },
                    { emoji: { name: '👍', id: null, animated: false }, count: 1, users: ['u3'] }
                ]
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.reactions).toHaveLength(2);
            expect(result[0].metadata.reactions[0].emoji).toEqual({ name: 'pepe', id: '123456789', animated: false });
            expect(result[0].metadata.reactions[0].count).toBe(2);
            expect(result[0].metadata.reactions[0].users).toEqual(['u1', 'u2']);
            expect(result[0].metadata.reactions[1].emoji).toEqual({ name: '👍', id: null, animated: false });
        });

        test('normalizes old-format emoji string to emoji object', () => {
            const messages = [createMockMessage({
                id: 'msg-old-emoji',
                reactions: [{ emoji: '🤌', count: 1, users: ['u1'] }]
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.reactions[0].emoji).toEqual({ name: '🤌', id: null, animated: false });
        });

        test('captures reply reference', () => {
            const messages = [createMockMessage({
                id: 'msg-reply',
                reference: {
                    messageId: 'original-msg',
                    channelId: 'channel-1',
                    guildId: 'guild-1'
                }
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.reference).toEqual({
                messageId: 'original-msg',
                channelId: 'channel-1',
                guildId: 'guild-1'
            });
        });

        test('captures attachment metadata from Map', () => {
            const attachments = new Map();
            attachments.set('att-1', {
                id: 'att-1',
                name: 'photo.png',
                url: 'https://cdn.discord/photo.png',
                size: 102400,
                contentType: 'image/png'
            });
            attachments.set('att-2', {
                id: 'att-2',
                name: 'doc.pdf',
                url: 'https://cdn.discord/doc.pdf',
                size: 50000,
                contentType: 'application/pdf'
            });

            const messages = [createMockMessage({ id: 'msg-att', attachments })];
            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.attachments).toHaveLength(2);
            expect(result[0].metadata.attachments[0]).toEqual({
                id: 'att-1',
                name: 'photo.png',
                url: 'https://cdn.discord/photo.png',
                size: 102400,
                contentType: 'image/png'
            });
        });

        test('captures embed data', () => {
            const messages = [createMockMessage({
                id: 'msg-embed',
                embeds: [{ data: { type: 'rich', title: 'Test Embed', description: 'Desc' } }]
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.embeds).toHaveLength(1);
            expect(result[0].metadata.embeds[0]).toEqual({ type: 'rich', title: 'Test Embed', description: 'Desc' });
        });

        test('captures message type for non-default messages', () => {
            const messages = [createMockMessage({ id: 'msg-type', type: 19 })]; // REPLY

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.type).toBe(19);
        });

        test('does not capture type 0 (DEFAULT)', () => {
            const messages = [createMockMessage({ id: 'msg-default', type: 0 })];
            const result = archive.scrubMessages(messages);
            expect(result[0].metadata).toBeUndefined();
        });

        test('captures editedTimestamp', () => {
            const messages = [createMockMessage({ id: 'msg-edit', editedTimestamp: 1700000000000 })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.editedTimestamp).toBe(1700000000000);
        });

        test('captures non-zero flags bitfield', () => {
            const messages = [createMockMessage({ id: 'msg-flags', flags: { bitfield: 4 } })]; // SUPPRESS_EMBEDS

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.flags).toBe(4);
        });

        test('captures pinned status', () => {
            const messages = [createMockMessage({ id: 'msg-pin', pinned: true })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.pinned).toBe(true);
        });

        test('captures webhookId and applicationId', () => {
            const messages = [createMockMessage({
                id: 'msg-webhook',
                webhookId: '436515089441488907',
                applicationId: '436515089441488907'
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.webhookId).toBe('436515089441488907');
            expect(result[0].metadata.applicationId).toBe('436515089441488907');
        });

        test('captures interaction metadata', () => {
            const messages = [createMockMessage({
                id: 'msg-interaction',
                interaction: { id: 'int-1', type: 2, commandName: 'set color' }
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.interaction).toEqual({
                id: 'int-1',
                type: 2,
                commandName: 'set color'
            });
        });

        test('captures mention data when users are mentioned', () => {
            const mentionedUsers = new Map();
            mentionedUsers.set('u1', { id: 'u1', username: 'Alice' });

            const messages = [createMockMessage({
                id: 'msg-mention',
                mentions: {
                    users: mentionedUsers,
                    roles: new Map(),
                    everyone: false,
                    repliedUser: null
                }
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.mentions.users).toEqual([{ id: 'u1', username: 'Alice' }]);
        });

        test('captures @everyone mention', () => {
            const messages = [createMockMessage({
                id: 'msg-everyone',
                mentions: {
                    users: new Map(),
                    roles: new Map(),
                    everyone: true,
                    repliedUser: null
                }
            })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.mentions.everyone).toBe(true);
        });

        test('captures system message flag', () => {
            const messages = [createMockMessage({ id: 'msg-sys', system: true })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.system).toBe(true);
        });

        test('captures non-zero position', () => {
            const messages = [createMockMessage({ id: 'msg-pos', position: 42 })];

            const result = archive.scrubMessages(messages);

            expect(result[0].metadata.position).toBe(42);
        });

        test('does not capture position when 0 or null', () => {
            const msg0 = createMockMessage({ id: 'msg-pos0', position: 0 });
            const msgNull = createMockMessage({ id: 'msg-posn', position: null });

            const result = archive.scrubMessages([msg0, msgNull]);

            expect(result[0].metadata).toBeUndefined();
            expect(result[1].metadata).toBeUndefined();
        });

        test('does not leak Discord.js internal properties into output', () => {
            const messages = [createMockMessage({ id: 'msg-clean' })];
            const result = archive.scrubMessages(messages);
            const keys = Object.keys(result[0]);

            // Should only have core fields, no Discord.js internals
            expect(keys).not.toContain('author');
            expect(keys).not.toContain('channel');
            expect(keys).not.toContain('guild');
            expect(keys).not.toContain('member');
        });
    });

    // ========================================================
    // createAuthorsMap
    // ========================================================

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

        test('handles empty messages array', () => {
            const result = archive.createAuthorsMap([]);
            expect(result).toEqual({});
        });
    });

    // ========================================================
    // getLastArchiveTime
    // ========================================================

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

    // ========================================================
    // parseChannelFolder
    // ========================================================

    describe('parseChannelFolder', () => {
        test('parses simple channel name', () => {
            const result = archive.parseChannelFolder('/path/to/general_198871224808505346');

            expect(result.channelId).toBe('198871224808505346');
            expect(result.channelName).toBe('general');
        });

        test('parses channel name with underscores', () => {
            const result = archive.parseChannelFolder('/path/to/me_irl_1283503582997385262');

            expect(result.channelId).toBe('1283503582997385262');
            expect(result.channelName).toBe('me_irl');
        });

        test('parses channel name with multiple underscores', () => {
            const result = archive.parseChannelFolder('/path/to/do_not_speak_1152447231056691252');

            expect(result.channelId).toBe('1152447231056691252');
            expect(result.channelName).toBe('do_not_speak');
        });
    });

    // ========================================================
    // processNewArchiveFiles
    // ========================================================

    describe('processNewArchiveFiles', () => {
        let mockDb;

        beforeEach(() => {
            mockDb = {
                run: jest.fn().mockResolvedValue(undefined),
                all: jest.fn().mockResolvedValue([]),
                get: jest.fn().mockResolvedValue(null)
            };
        });

        test('inserts messages with correct author_id from authors file', async () => {
            const archiveData = [
                { id: 'msg-1', createdTimestamp: 1000, content: 'Hello' },
                { id: 'msg-2', createdTimestamp: 2000, content: 'World' }
            ];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-1'] },
                'user-B': { id: 'user-B', username: 'Bob', globalName: 'Bob', msgIds: ['msg-2'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            // BEGIN + 2 INSERTs + COMMIT = 4 calls
            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            expect(insertCalls).toHaveLength(2);

            // db.run(sql, [params]) — params array is at index 1
            // Params order: id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata
            expect(insertCalls[0][1][3]).toBe('user-A');
            expect(insertCalls[1][1][3]).toBe('user-B');
        });

        test('correctly parses channel_id from folder names with underscores', async () => {
            const archiveData = [{ id: 'msg-1', createdTimestamp: 1000, content: 'test' }];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-1'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/me_irl_1283503582997385262');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            // Params: [id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata]
            expect(insertCalls[0][1][5]).toBe('1283503582997385262');
            expect(insertCalls[0][1][6]).toBe('me_irl');
        });

        test('merges old-format fields into metadata JSON', async () => {
            const archiveData = [{
                id: 'msg-old',
                createdTimestamp: 1000,
                content: 'old format',
                position: 42,
                embeds: { '0': { data: { type: 'video', title: 'test' } } },
                reactions: [{ emoji: '👍', count: 1, users: ['u1'] }],
                nonce: '12345'
            }];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-old'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            // Params: [id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata]
            const metadataStr = insertCalls[0][1][8];
            const metadata = JSON.parse(metadataStr);

            expect(metadata.position).toBe(42);
            expect(metadata.embeds).toBeDefined();
            expect(metadata.reactions).toHaveLength(1);
            expect(metadata.nonce).toBe('12345');
        });

        test('uses metadata property directly for new-format archives', async () => {
            const archiveData = [{
                id: 'msg-new',
                createdTimestamp: 1000,
                content: 'new format',
                metadata: {
                    reactions: [{ emoji: { name: '👍', id: null, animated: false }, count: 1, users: ['u1'] }],
                    type: 19,
                    editedTimestamp: 1500
                }
            }];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-new'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            const metadata = JSON.parse(insertCalls[0][1][8]);

            expect(metadata.type).toBe(19);
            expect(metadata.editedTimestamp).toBe(1500);
            expect(metadata.reactions[0].emoji.name).toBe('👍');
        });

        test('skips messages without matching author', async () => {
            const archiveData = [
                { id: 'msg-orphan', createdTimestamp: 1000, content: 'no author' }
            ];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-other'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            expect(insertCalls).toHaveLength(0);
        });

        test('stores null metadata when message has no extra fields', async () => {
            const archiveData = [
                { id: 'msg-bare', createdTimestamp: 1000, content: 'bare message' }
            ];
            const authorsData = {
                'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-bare'] }
            };

            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_')) return JSON.stringify(archiveData);
                if (filePath.includes('authors_')) return JSON.stringify(authorsData);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            expect(insertCalls[0][1][8]).toBeNull(); // metadata should be null
        });

        test('skips archive files with missing authors file', async () => {
            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockImplementation((filePath) => {
                if (filePath.includes('authors_')) return false;
                return true;
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            expect(insertCalls).toHaveLength(0);
        });

        test('processes multiple archive files in one channel', async () => {
            const archiveData1 = [{ id: 'msg-1', createdTimestamp: 1000, content: 'first' }];
            const authorsData1 = { 'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-1'] } };
            const archiveData2 = [{ id: 'msg-2', createdTimestamp: 2000, content: 'second' }];
            const authorsData2 = { 'user-A': { id: 'user-A', username: 'Alice', globalName: 'Alice', msgIds: ['msg-2'] } };

            fs.readdirSync.mockReturnValue(['archive_1000.json', 'archive_2000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation((filePath) => {
                if (filePath.includes('archive_1000')) return JSON.stringify(archiveData1);
                if (filePath.includes('authors_1000')) return JSON.stringify(authorsData1);
                if (filePath.includes('archive_2000')) return JSON.stringify(archiveData2);
                if (filePath.includes('authors_2000')) return JSON.stringify(authorsData2);
                return '';
            });

            await archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345');

            const insertCalls = mockDb.run.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT')
            );
            expect(insertCalls).toHaveLength(2);
        });

        test('rolls back transaction on error', async () => {
            fs.readdirSync.mockReturnValue(['archive_1000.json']);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation(() => {
                throw new Error('Read error');
            });

            await expect(
                archive.processNewArchiveFiles(mockDb, 'guild-1', '/path/to/general_12345')
            ).rejects.toThrow('Read error');

            const rollbackCalls = mockDb.run.mock.calls.filter(c => c[0] === 'ROLLBACK');
            expect(rollbackCalls).toHaveLength(1);
        });
    });

    // ========================================================
    // updateReactionData
    // ========================================================

    describe('updateReactionData', () => {
        test('populates reaction data with emoji name, ID, and animated flag', async () => {
            const mockReaction = {
                emoji: { name: 'pepe', id: '123456', animated: true },
                count: 2,
                users: {
                    fetch: jest.fn().mockResolvedValue(
                        createMockCollection([
                            ['u1', { id: 'u1' }],
                            ['u2', { id: 'u2' }]
                        ])
                    )
                }
            };
            const reactionCache = new Map();
            reactionCache.set('pepe', mockReaction);

            const fetchedMsg = {
                id: 'msg-1',
                reactions: { cache: reactionCache }
            };

            const mockChannel = {
                messages: {
                    fetch: jest.fn().mockResolvedValue(
                        new Map([['msg-1', fetchedMsg]])
                    )
                }
            };

            const messages = [{
                id: 'msg-1',
                channel: mockChannel,
                reactions: { cache: new Map() }
            }];

            await archive.updateReactionData(messages);

            expect(Array.isArray(messages[0].reactions)).toBe(true);
            expect(messages[0].reactions[0].emoji).toEqual({
                name: 'pepe',
                id: '123456',
                animated: true
            });
            expect(messages[0].reactions[0].count).toBe(2);
            expect(messages[0].reactions[0].users).toEqual(['u1', 'u2']);
        });

        test('does not modify messages with no reactions', async () => {
            const fetchedMsg = {
                id: 'msg-1',
                reactions: { cache: new Map() } // empty cache
            };

            const mockChannel = {
                messages: {
                    fetch: jest.fn().mockResolvedValue(
                        new Map([['msg-1', fetchedMsg]])
                    )
                }
            };

            const messages = [{
                id: 'msg-1',
                channel: mockChannel,
                reactions: { cache: new Map() }
            }];

            await archive.updateReactionData(messages);

            // reactions should still be the original object, not an array
            expect(Array.isArray(messages[0].reactions)).toBe(false);
        });

        test('handles fetch errors for individual reactions without throwing', async () => {
            const goodReaction = {
                emoji: { name: '👍', id: null, animated: false },
                count: 1,
                users: {
                    fetch: jest.fn().mockResolvedValue(
                        createMockCollection([['u1', { id: 'u1' }]])
                    )
                }
            };
            const badReaction = {
                emoji: { name: '💀', id: null, animated: false },
                count: 1,
                users: {
                    fetch: jest.fn().mockRejectedValue(new Error('API error'))
                }
            };

            const reactionCache = new Map();
            reactionCache.set('👍', goodReaction);
            reactionCache.set('💀', badReaction);

            const fetchedMsg = {
                id: 'msg-1',
                reactions: { cache: reactionCache }
            };

            const mockChannel = {
                messages: {
                    fetch: jest.fn().mockResolvedValue(
                        new Map([['msg-1', fetchedMsg]])
                    )
                }
            };

            const messages = [{
                id: 'msg-1',
                channel: mockChannel,
                reactions: { cache: new Map() }
            }];

            // Should not throw
            await archive.updateReactionData(messages);

            // Good reaction should still be captured
            expect(messages[0].reactions).toHaveLength(1);
            expect(messages[0].reactions[0].emoji.name).toBe('👍');
        });
    });
});
