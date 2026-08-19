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
    createMockCollection,
    createMockScheduledEvent
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
    },
    GuildScheduledEventStatus: {
        Scheduled: 1,
        Active: 2,
        Completed: 3,
        Canceled: 4
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
                    getInteger: jest.fn(() => null),
                    getString: jest.fn((name) => name === 'id' ? String(eventItem.id) : null)
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

    describe('Event fireItem', () => {
        it('should use eventName (not message) when firing an event item', async () => {
            // Create an event via /event command
            const interaction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Basketball Pickup Game',
                            'start': '10s',
                            'type': 'voice',
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => mockChannel),
                    getAttachment: jest.fn(() => null)
                }
            });

            await scheduler.handleEventCommand(interaction);

            // Set the event trigger time to the past so it fires
            const data = scheduler.loadScheduledItems('test-guild-integration');
            const eventItem = data.items.find(i => i.type === 'event');
            expect(eventItem).toBeDefined();
            expect(eventItem.eventName).toBe('Basketball Pickup Game');
            expect(eventItem.message).toBeUndefined();

            eventItem.triggerAt = new Date(Date.now() - 1000).toISOString();
            scheduler.saveScheduledItems('test-guild-integration', data);

            // Trigger the scheduler check
            await scheduler.checkAllItems();

            // Verify the sent message uses eventName, not "undefined"
            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0];
            const [title, link] = sendCall.content.split('\n');
            expect(title).toBe('**Event:** Basketball Pickup Game');
            // ...and now carries a way to actually reach the event.
            expect(link).toBe(
                `https://discord.com/events/test-guild-integration/${eventItem.scheduledEventId}`
            );
            expect(sendCall.content).not.toContain('undefined');
        });
    });

    // ── Reconciling items against the live Discord event ─────────────────────
    //
    // The gap these cover: an item is a copy of the event, refreshed only by
    // the guildScheduledEventUpdate gateway event, which needs the bot to be
    // connected at the instant of the edit. It restarts on every deploy. An
    // event moved, renamed or cancelled inside one of those windows used to
    // leave the item describing something that no longer exists — and it fired
    // anyway, at the old time, under the old name, pinging everyone who had
    // marked interest. That shipped: a reminder went out for "Big Walk #3" an
    // hour before a time the event had stopped claiming.
    describe('reconcileWithScheduledEvent', () => {
        const GUILD = 'test-guild-integration';
        const HOUR = 3600 * 1000;

        /** Put a live scheduled event on the guild and return it. */
        function liveEvent(overrides = {}) {
            const event = createMockScheduledEvent({
                id: 'evt-live',
                name: 'Big Walk #3',
                ...overrides
            });
            mockGuild.scheduledEvents.cache.set(event.id, event);
            return event;
        }

        /** Store one item and hand it back after the tick has run. */
        async function tickWith(item) {
            const data = scheduler.loadScheduledItems(GUILD);
            data.items.push({
                id: 1,
                guildId: GUILD,
                channelId: mockChannel.id,
                creatorId: 'creator-1',
                scheduledEventId: 'evt-live',
                eventName: 'Big Walk #3',
                recurring: null,
                createdDate: new Date().toISOString(),
                active: true,
                ...item
            });
            scheduler.saveScheduledItems(GUILD, data);
            await scheduler.checkAllItems();
            return scheduler.loadScheduledItems(GUILD).items.find((i) => i.id === 1);
        }

        it('does not fire a reminder for an event that moved out from under it', async () => {
            liveEvent({ scheduledStartTime: new Date(Date.now() + 25 * HOUR) });

            const item = await tickWith({
                type: 'event_reminder',
                remindBeforeMs: HOUR,
                // What the item still believes: the event started an hour ago,
                // so its advance warning is overdue and would go out this tick.
                triggerAt: new Date(Date.now() - HOUR).toISOString()
            });

            expect(mockChannel.send).not.toHaveBeenCalled();
            // Re-pointed at the live start minus its lead, and still armed.
            expect(item.active).toBe(true);
            expect(new Date(item.triggerAt).getTime()).toBeCloseTo(Date.now() + 24 * HOUR, -4);
        });

        it('fires at the new time, under the new name', async () => {
            liveEvent({
                name: 'Big Walk #3 (moved)',
                scheduledStartTime: new Date(Date.now() + HOUR - 5000)
            });

            const item = await tickWith({
                type: 'event_reminder',
                remindBeforeMs: HOUR,
                triggerAt: new Date(Date.now() + 20 * HOUR).toISOString()
            });

            expect(mockChannel.send).toHaveBeenCalledTimes(1);
            const sent = mockChannel.send.mock.calls[0][0];
            expect(sent.content).toContain('Big Walk #3 (moved)');
            expect(sent.content).toContain('starts in 1h');
            expect(item.eventName).toBe('Big Walk #3 (moved)');
            expect(item.active).toBe(false);
        });

        it('retires a reminder whose event moved to a start already past', async () => {
            liveEvent({ scheduledStartTime: new Date(Date.now() - HOUR) });

            const item = await tickWith({
                type: 'event_reminder',
                remindBeforeMs: HOUR,
                triggerAt: new Date(Date.now() - 2 * HOUR).toISOString()
            });

            // An advance warning for something that already began is not one.
            expect(mockChannel.send).not.toHaveBeenCalled();
            expect(item.active).toBe(false);
        });

        it('drops a cancelled event instead of announcing it', async () => {
            liveEvent({
                status: 4, // GuildScheduledEventStatus.Canceled
                scheduledStartTime: new Date(Date.now() + HOUR)
            });

            const item = await tickWith({
                type: 'event',
                triggerAt: new Date(Date.now() - 1000).toISOString()
            });

            expect(mockChannel.send).not.toHaveBeenCalled();
            expect(item.active).toBe(false);
        });

        it('drops a deleted event instead of reminding about it', async () => {
            // Nothing added to the cache: the mock's fetch answers 10070, the
            // same code Discord returns for an event that is gone. The reminder
            // path used to swallow that and post regardless.
            const item = await tickWith({
                type: 'event_reminder',
                remindBeforeMs: HOUR,
                scheduledEventId: 'evt-deleted',
                triggerAt: new Date(Date.now() - 1000).toISOString()
            });

            expect(mockChannel.send).not.toHaveBeenCalled();
            expect(item.active).toBe(false);
        });

        it('still fires when the event merely could not be read', async () => {
            // A rate limit is not evidence that anything changed, and dropping
            // a real reminder over one is the worse failure.
            mockGuild.scheduledEvents.fetch = jest.fn().mockRejectedValue(
                Object.assign(new Error('rate limited'), { status: 429 })
            );

            const item = await tickWith({
                type: 'event',
                triggerAt: new Date(Date.now() - 1000).toISOString()
            });

            expect(mockChannel.send).toHaveBeenCalledTimes(1);
            expect(item.active).toBe(false); // fired, one-time
        });

        it('leaves a recurring item on its own sequence', async () => {
            // A recurring event rides a Discord-native recurrence rule, so the
            // live scheduledStartTime is the NEXT occurrence while our
            // triggerAt walks its own. Reconciling one to the other would drag
            // every future occurrence back onto whichever Discord points at.
            const nextWeek = new Date(Date.now() + 7 * 24 * HOUR);
            liveEvent({ scheduledStartTime: nextWeek });

            const ownTime = new Date(Date.now() + 3 * 24 * HOUR).toISOString();
            const item = await tickWith({
                type: 'event',
                recurring: '1w',
                triggerAt: ownTime
            });

            expect(item.triggerAt).toBe(ownTime);
            expect(mockChannel.send).not.toHaveBeenCalled();
        });

        it('pays for a definitive read only when the item is about to speak', async () => {
            const start = new Date(Date.now() + 5 * HOUR);
            liveEvent({ scheduledStartTime: start });
            const fetchSpy = jest.spyOn(mockGuild.scheduledEvents, 'fetch');

            // Not due: the gateway cache is good enough, and forcing an API
            // read for every item on every 60s tick is not.
            await tickWith({ type: 'event', triggerAt: start.toISOString() });
            expect(fetchSpy).toHaveBeenCalledWith(
                expect.objectContaining({ force: false })
            );

            fetchSpy.mockClear();
            const data = scheduler.loadScheduledItems(GUILD);
            data.items.find((i) => i.id === 1).triggerAt = new Date(Date.now() - 1000).toISOString();
            scheduler.saveScheduledItems(GUILD, data);
            await scheduler.checkAllItems();

            expect(fetchSpy).toHaveBeenCalledWith(
                expect.objectContaining({ guildScheduledEvent: 'evt-live', force: true })
            );
        });

        it('picks up a rename without touching the schedule', async () => {
            const start = new Date(Date.now() + 5 * HOUR);
            liveEvent({ name: 'Renamed In Discord', scheduledStartTime: start });

            const item = await tickWith({
                type: 'event',
                triggerAt: start.toISOString()
            });

            expect(item.eventName).toBe('Renamed In Discord');
            expect(item.triggerAt).toBe(start.toISOString());
        });

        it('does not clear a stored location for an event that carries no metadata', async () => {
            const start = new Date(Date.now() + 5 * HOUR);
            liveEvent({ scheduledStartTime: start, entityMetadata: null });

            const item = await tickWith({
                type: 'event',
                location: 'https://hadoku.me/meet?e=qqmt7yfkkhh2',
                triggerAt: start.toISOString()
            });

            expect(item.location).toBe('https://hadoku.me/meet?e=qqmt7yfkkhh2');
        });
    });

    describe('buildEventStartMessage', () => {
        const base = {
            eventName: 'Big Walk #2',
            guildId: 'guild-1',
            scheduledEventId: 'event-1',
        };

        it('links the Discord event', () => {
            expect(scheduler.buildEventStartMessage(base)).toBe(
                '**Event:** Big Walk #2\nhttps://discord.com/events/guild-1/event-1'
            );
        });

        it('adds a URL location — the meet link is the actionable one', () => {
            const content = scheduler.buildEventStartMessage({
                ...base,
                location: 'https://hadoku.me/meet?e=qey2bkee5ath',
            });
            expect(content.split('\n')).toEqual([
                '**Event:** Big Walk #2',
                'https://discord.com/events/guild-1/event-1',
                'https://hadoku.me/meet?e=qey2bkee5ath',
            ]);
        });

        it('does not echo a non-URL location back as a link', () => {
            // /event defaults an external event's location to its own name, so
            // printing it unconditionally would repeat the title.
            const content = scheduler.buildEventStartMessage({
                ...base,
                eventName: 'Big walk',
                location: 'Big walk',
            });
            expect(content).toBe('**Event:** Big walk\nhttps://discord.com/events/guild-1/event-1');
        });

        it('survives an item with no ids or location', () => {
            expect(scheduler.buildEventStartMessage({ eventName: 'Bare' })).toBe('**Event:** Bare');
        });

        it('ignores a null location without printing "null"', () => {
            const content = scheduler.buildEventStartMessage({ ...base, location: null });
            expect(content).not.toContain('null');
        });
    });

    describe('Date-only and slash-format parsing', () => {
        it('should parse M/D/YYYY format defaulting to noon', () => {
            const result = scheduler.parseDateTime('3/5/2026');
            expect(result).not.toBeNull();
            expect(result.getFullYear()).toBe(2026);
            expect(result.getMonth()).toBe(2); // March = 0-indexed
            expect(result.getDate()).toBe(5);
            expect(result.getHours()).toBe(12);
            expect(result.getMinutes()).toBe(0);
        });

        it('should parse MM/DD/YYYY format', () => {
            const result = scheduler.parseDateTime('12/25/2026');
            expect(result).not.toBeNull();
            expect(result.getFullYear()).toBe(2026);
            expect(result.getMonth()).toBe(11);
            expect(result.getDate()).toBe(25);
            expect(result.getHours()).toBe(12);
        });

        it('should parse M/D/YYYY with 12h time', () => {
            const result = scheduler.parseDateTime('3/5/2026 4pm');
            expect(result).not.toBeNull();
            expect(result.getFullYear()).toBe(2026);
            expect(result.getMonth()).toBe(2);
            expect(result.getDate()).toBe(5);
            expect(result.getHours()).toBe(16);
            expect(result.getMinutes()).toBe(0);
        });

        it('should parse M/D/YYYY with 24h time', () => {
            const result = scheduler.parseDateTime('3/5/2026 14:30');
            expect(result).not.toBeNull();
            expect(result.getHours()).toBe(14);
            expect(result.getMinutes()).toBe(30);
        });

        it('should parse ISO date-only YYYY-MM-DD defaulting to noon', () => {
            const result = scheduler.parseDateTime('2026-03-05');
            expect(result).not.toBeNull();
            expect(result.getFullYear()).toBe(2026);
            expect(result.getMonth()).toBe(2);
            expect(result.getDate()).toBe(5);
            expect(result.getHours()).toBe(12);
            expect(result.getMinutes()).toBe(0);
        });

        it('should reject invalid dates like 2/30', () => {
            expect(scheduler.parseDateTime('2/30/2026')).toBeNull();
        });

        it('should reject invalid month', () => {
            expect(scheduler.parseDateTime('13/5/2026')).toBeNull();
        });
    });

    describe('Simplified event creation (no type)', () => {
        it('should create an external event with defaults when type is omitted', async () => {
            const interaction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Timeborn 1.0 Release',
                            'start': '3/5/2026'
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => null),
                    getAttachment: jest.fn(() => null)
                }
            });

            await scheduler.handleEventCommand(interaction);

            // Verify event was created via Discord API
            expect(mockGuild.scheduledEvents.create).toHaveBeenCalled();
            const createCall = mockGuild.scheduledEvents.create.mock.calls[0][0];

            // Should default to external entity type
            expect(createCall.entityType).toBe(3); // External

            // Should have the event name as default location
            expect(createCall.entityMetadata.location).toBe('Timeborn 1.0 Release');

            // Should have start time at noon on 3/5/2026
            expect(createCall.scheduledStartTime.getFullYear()).toBe(2026);
            expect(createCall.scheduledStartTime.getMonth()).toBe(2);
            expect(createCall.scheduledStartTime.getDate()).toBe(5);
            expect(createCall.scheduledStartTime.getHours()).toBe(12);

            // Should have default end time (start + 1 hour)
            expect(createCall.scheduledEndTime).toBeDefined();
            expect(createCall.scheduledEndTime.getTime())
                .toBe(createCall.scheduledStartTime.getTime() + 3600000);

            // Verify the scheduler item was persisted correctly
            const data = scheduler.loadScheduledItems('test-guild-integration');
            const eventItem = data.items.find(i => i.type === 'event');
            expect(eventItem).toBeDefined();
            expect(eventItem.eventName).toBe('Timeborn 1.0 Release');
            expect(eventItem.scheduledEventId).toBeDefined();
            expect(eventItem.active).toBe(true);
            expect(eventItem.channelId).toBe(mockChannel.id);

            // Reply should confirm creation
            expect(interaction.editReply).toHaveBeenCalled();
            const reply = interaction.editReply.mock.calls[0][0];
            expect(reply).toContain('Event Created');
            expect(reply).toContain('Timeborn 1.0 Release');
        });

        it('should fire the simplified event through the scheduler loop', async () => {
            // Step 1: Create a simplified event (no type, no location, no end)
            const interaction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Game Night',
                            'start': '5s' // Use relative time so it's near-future
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => null),
                    getAttachment: jest.fn(() => null)
                }
            });

            await scheduler.handleEventCommand(interaction);

            // Step 2: Verify the event was created and persisted
            let data = scheduler.loadScheduledItems('test-guild-integration');
            const eventItem = data.items.find(i => i.type === 'event');
            expect(eventItem).toBeDefined();
            expect(eventItem.eventName).toBe('Game Night');
            expect(eventItem.active).toBe(true);

            // Step 3: Move the trigger time to the past so it fires
            eventItem.triggerAt = new Date(Date.now() - 1000).toISOString();
            scheduler.saveScheduledItems('test-guild-integration', data);

            // Step 4: Run the scheduler check
            await scheduler.checkAllItems();

            // Step 5: Verify the event message was sent to the channel
            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0];
            const [title, link] = sendCall.content.split('\n');
            expect(title).toBe('**Event:** Game Night');
            expect(link).toBe(
                `https://discord.com/events/test-guild-integration/${eventItem.scheduledEventId}`
            );
            expect(sendCall.content).not.toContain('undefined');

            // Step 6: Verify the event was deactivated (one-time, no recurring)
            data = scheduler.loadScheduledItems('test-guild-integration');
            const firedItem = data.items.find(i => i.eventName === 'Game Night');
            expect(firedItem.active).toBe(false);
            expect(firedItem.lastTriggered).not.toBeNull();
        });

        it('should be removable via /remove after simplified creation', async () => {
            // Create simplified event
            const createInteraction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => {
                        const values = {
                            'name': 'Cleanup Test Event',
                            'start': '1h'
                        };
                        return values[name] || null;
                    }),
                    getChannel: jest.fn(() => null),
                    getAttachment: jest.fn(() => null)
                }
            });

            await scheduler.handleEventCommand(createInteraction);

            // Verify it exists
            let data = scheduler.loadScheduledItems('test-guild-integration');
            const eventItem = data.items.find(i => i.type === 'event');
            expect(eventItem).toBeDefined();

            // Remove it via /remove
            const removeInteraction = createMockInteraction({
                guild: mockGuild,
                guildId: 'test-guild-integration',
                channel: mockChannel,
                user: { id: 'creator-user-123', username: 'EventCreator' },
                options: {
                    getString: jest.fn((name) => name === 'id' ? String(eventItem.id) : null),
                    getInteger: jest.fn(() => null)
                }
            });

            await scheduler.handleRemoveCommand(removeInteraction);

            // Verify it's gone
            data = scheduler.loadScheduledItems('test-guild-integration');
            expect(data.items.filter(i => i.type === 'event').length).toBe(0);

            // Verify the Discord scheduled event was deleted
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
