/**
 * Integration tests for scheduler event_reminder functionality
 * Tests the full flow: create event -> add interested users -> fire reminder
 */

const path = require('path');
const fs = require('fs');
const {
    createMockGuild,
    createMockChannel,
    createMockInteraction,
    createMockCollection
} = require('./mocks/discord');

// Mock discord.js enums before requiring scheduler
jest.mock('discord.js', () => ({
    GuildScheduledEventEntityType: {
        Voice: 2,
        StageInstance: 1,
        External: 3
    },
    GuildScheduledEventPrivacyLevel: {
        GuildOnly: 2
    },
    GuildScheduledEventRecurrenceRuleFrequency: {
        Daily: 0,
        Weekly: 1,
        Monthly: 2,
        Yearly: 3
    }
}));

// Mock permissions to always allow access
jest.mock('../lib/permissions', () => ({
    checkTaskAccessWithRoles: jest.fn().mockResolvedValue(true),
    hasAdminAccess: jest.fn().mockResolvedValue(true),
    hasTaskAccess: jest.fn().mockResolvedValue(true)
}));

const scheduler = require('../lib/scheduler');

describe('Scheduler Integration Tests', () => {
    let mockGuild;
    let mockChannel;
    let testOutputDir;
    let originalFs;

    beforeEach(() => {
        // Create test output directory
        testOutputDir = path.join(__dirname, '..', 'Output', 'test-guild-integration');
        if (!fs.existsSync(testOutputDir)) {
            fs.mkdirSync(testOutputDir, { recursive: true });
        }

        // Clean up any existing scheduled.json
        const scheduledPath = path.join(testOutputDir, 'scheduled.json');
        if (fs.existsSync(scheduledPath)) {
            fs.unlinkSync(scheduledPath);
        }

        // Create mock guild with scheduled events support
        mockChannel = createMockChannel({
            id: 'voice-channel-123',
            name: 'Test Voice Channel',
            type: 2 // GUILD_VOICE
        });

        mockGuild = createMockGuild({
            id: 'test-guild-integration'
        });
        mockGuild.channels.cache.set(mockChannel.id, mockChannel);

        // Initialize scheduler with a mock client
        const mockClient = {
            guilds: {
                cache: createMockCollection([
                    ['test-guild-integration', mockGuild]
                ])
            },
            channels: {
                fetch: jest.fn().mockImplementation((channelId) => {
                    const channel = mockGuild.channels.cache.get(channelId);
                    if (channel) return Promise.resolve(channel);
                    return Promise.reject({ code: 10003, message: 'Unknown Channel' });
                })
            }
        };
        scheduler.initializeScheduler(mockClient);
    });

    afterEach(() => {
        scheduler.stopScheduler();

        // Clean up test files
        const scheduledPath = path.join(testOutputDir, 'scheduled.json');
        if (fs.existsSync(scheduledPath)) {
            fs.unlinkSync(scheduledPath);
        }
    });

    describe('Event with remind_before', () => {
        it('should create event and event_reminder items', async () => {
            // Create interaction for /event command
            const interaction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Test Integration Event',
                            'start': '10s', // 10 seconds from now
                            'type': 'voice',
                            'description': 'Integration test event',
                            'remind_before': '5s' // 5 seconds before (so 5s from now)
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => mockChannel),
                    getAttachment: jest.fn(() => null)
                }
            });

            // Execute the event command
            await scheduler.handleEventCommand(interaction);

            // Verify the event was created
            expect(mockGuild.scheduledEvents.create).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalled();

            // Load the scheduled items and verify both were created
            const data = scheduler.loadScheduledItems('test-guild-integration');

            const eventItem = data.items.find(i => i.type === 'event');
            const reminderItem = data.items.find(i => i.type === 'event_reminder');

            expect(eventItem).toBeDefined();
            expect(eventItem.eventName).toBe('Test Integration Event');
            expect(eventItem.scheduledEventId).toBeDefined();

            expect(reminderItem).toBeDefined();
            expect(reminderItem.eventName).toBe('Test Integration Event');
            expect(reminderItem.scheduledEventId).toBe(eventItem.scheduledEventId);
            expect(reminderItem.remindBeforeMs).toBeGreaterThan(0);
        });

        it('should mention interested users when event_reminder fires', async () => {
            // Create interaction for /event command
            const interaction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Subscriber Test Event',
                            'start': '2s', // 2 seconds from now
                            'type': 'voice',
                            'remind_before': '1s' // 1 second before
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => mockChannel),
                    getAttachment: jest.fn(() => null)
                }
            });

            // Execute the event command
            await scheduler.handleEventCommand(interaction);

            // Get the created event from the cache
            let data = scheduler.loadScheduledItems('test-guild-integration');
            const eventItem = data.items.find(i => i.type === 'event');
            const scheduledEvent = mockGuild.scheduledEvents.cache.get(eventItem.scheduledEventId);

            // Add interested users to the event
            scheduledEvent._addSubscriber('interested-user-1');
            scheduledEvent._addSubscriber('interested-user-2');
            scheduledEvent._addSubscriber('interested-user-3');

            // Manually set the reminder trigger time to now (for immediate testing)
            data = scheduler.loadScheduledItems('test-guild-integration');
            const reminderItem = data.items.find(i => i.type === 'event_reminder');
            reminderItem.triggerAt = new Date(Date.now() - 1000).toISOString(); // 1 second ago
            scheduler.saveScheduledItems('test-guild-integration', data);

            // Stop current scheduler and set up a fresh mock client for checkAllItems
            scheduler.stopScheduler();
            const mockClient = {
                guilds: {
                    cache: createMockCollection([
                        ['test-guild-integration', mockGuild]
                    ])
                },
                channels: {
                    fetch: jest.fn().mockImplementation((channelId) => {
                        const channel = mockGuild.channels.cache.get(channelId);
                        if (channel) return Promise.resolve(channel);
                        return Promise.reject({ code: 10003, message: 'Unknown Channel' });
                    })
                }
            };
            // Initialize but don't rely on its automatic check
            scheduler.initializeScheduler(mockClient);

            // Wait a tick to ensure any pending ops complete, then manually trigger check
            await new Promise(resolve => setImmediate(resolve));
            await scheduler.checkAllItems();

            // Verify the channel.send was called with mentions for all interested users
            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0];

            // Should mention creator and all interested users
            expect(sendCall.content).toContain('<@creator-user-123>');
            expect(sendCall.content).toContain('<@interested-user-1>');
            expect(sendCall.content).toContain('<@interested-user-2>');
            expect(sendCall.content).toContain('<@interested-user-3>');
            expect(sendCall.content).toContain('Subscriber Test Event');
            expect(sendCall.content).toContain('starts in');

            // Verify allowedMentions includes all users
            expect(sendCall.allowedMentions.users).toContain('creator-user-123');
            expect(sendCall.allowedMentions.users).toContain('interested-user-1');
            expect(sendCall.allowedMentions.users).toContain('interested-user-2');
            expect(sendCall.allowedMentions.users).toContain('interested-user-3');
        });

        it('should clean up event_reminder when event is removed', async () => {
            // Create interaction for /event command
            const createInteraction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Event To Remove',
                            'start': '1h',
                            'type': 'voice',
                            'remind_before': '30m'
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => mockChannel),
                    getAttachment: jest.fn(() => null)
                }
            });

            await scheduler.handleEventCommand(createInteraction);

            // Verify both items exist
            let data = scheduler.loadScheduledItems('test-guild-integration');
            expect(data.items.filter(i => i.type === 'event').length).toBe(1);
            expect(data.items.filter(i => i.type === 'event_reminder').length).toBe(1);

            const eventItem = data.items.find(i => i.type === 'event');

            // Create interaction for /remove command
            const removeInteraction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getInteger: jest.fn((name) => name === 'id' ? eventItem.id : null),
                    getString: jest.fn(() => null)
                }
            });

            await scheduler.handleRemoveCommand(removeInteraction);

            // Verify both items are removed
            data = scheduler.loadScheduledItems('test-guild-integration');
            expect(data.items.filter(i => i.type === 'event').length).toBe(0);
            expect(data.items.filter(i => i.type === 'event_reminder').length).toBe(0);

            // Verify Discord event was deleted
            const scheduledEvent = mockGuild.scheduledEvents.cache.get(eventItem.scheduledEventId);
            expect(scheduledEvent.delete).toHaveBeenCalled();
        });
    });

    describe('Time parsing for seconds', () => {
        it('should parse seconds correctly', () => {
            const testCases = [
                { input: '5s', expectedMs: 5000 },
                { input: '30s', expectedMs: 30000 },
                { input: '60s', expectedMs: 60000 },
                { input: '10sec', expectedMs: 10000 },
                { input: '15secs', expectedMs: 15000 },
                { input: '20seconds', expectedMs: 20000 }
            ];

            for (const { input, expectedMs } of testCases) {
                const now = Date.now();
                const result = scheduler.parseRelativeTime(input);
                expect(result).not.toBeNull();
                // Allow 100ms tolerance for test execution time
                expect(result.getTime() - now).toBeGreaterThanOrEqual(expectedMs - 100);
                expect(result.getTime() - now).toBeLessThanOrEqual(expectedMs + 100);
            }
        });
    });
});
