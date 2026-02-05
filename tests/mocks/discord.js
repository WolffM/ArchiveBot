/**
 * Mock utilities for Discord.js objects
 * Used for testing bot functionality without hitting Discord API
 */

/**
 * Creates a mock Discord interaction object
 */
function createMockInteraction(overrides = {}) {
    return {
        guildId: 'test-guild-123',
        guild: {
            id: 'test-guild-123',
            name: 'Test Guild',
            roles: {
                cache: new Map()
            },
            members: {
                fetch: jest.fn().mockResolvedValue(createMockMember()),
                cache: new Map()
            }
        },
        user: {
            id: 'test-user-456',
            username: 'TestUser',
            tag: 'TestUser#0001'
        },
        member: createMockMember(),
        channel: createMockChannel(),
        options: {
            getString: jest.fn().mockReturnValue(null),
            getInteger: jest.fn().mockReturnValue(null),
            getBoolean: jest.fn().mockReturnValue(null)
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        deferred: false,
        replied: false,
        ...overrides
    };
}

/**
 * Creates a mock Discord message object (for archive tests)
 */
function createMockMessage(overrides = {}) {
    return {
        id: `msg-${Date.now()}`,
        content: 'Test message content',
        createdTimestamp: Date.now(),
        author: {
            id: 'author-123',
            username: 'MessageAuthor',
            globalName: 'Message Author'
        },
        reactions: {
            cache: new Map()
        },
        reference: null,
        attachments: new Map(),
        channel: createMockChannel(),
        ...overrides
    };
}

/**
 * Creates a mock Discord Collection (Map with array-like methods like discord.js)
 */
function createMockCollection(entries = []) {
    const map = new Map(entries);
    // Add Discord.js Collection methods
    map.some = function(fn) {
        for (const [key, value] of this) {
            if (fn(value, key, this)) return true;
        }
        return false;
    };
    map.filter = function(fn) {
        const result = createMockCollection();
        for (const [key, value] of this) {
            if (fn(value, key, this)) result.set(key, value);
        }
        return result;
    };
    map.find = function(fn) {
        for (const [key, value] of this) {
            if (fn(value, key, this)) return value;
        }
        return undefined;
    };
    map.map = function(fn) {
        const result = [];
        for (const [key, value] of this) {
            result.push(fn(value, key, this));
        }
        return result;
    };
    return map;
}

/**
 * Creates a mock guild member
 */
function createMockMember(roles = []) {
    const roleCollection = createMockCollection(roles.map(r => [r.id, r]));
    return {
        id: 'member-123',
        user: {
            id: 'member-123',
            username: 'TestMember',
            tag: 'TestMember#0001'
        },
        roles: {
            cache: roleCollection,
            add: jest.fn().mockResolvedValue(undefined),
            remove: jest.fn().mockResolvedValue(undefined),
            has: jest.fn((id) => roleCollection.has(id))
        }
    };
}

/**
 * Creates a mock Discord channel
 */
function createMockChannel(overrides = {}) {
    return {
        id: 'channel-123',
        name: 'test-channel',
        isTextBased: () => true,
        messages: {
            fetch: jest.fn().mockResolvedValue(new Map()),
            cache: new Map()
        },
        send: jest.fn().mockResolvedValue(undefined),
        bulkDelete: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

/**
 * Creates a mock Discord role
 */
function createMockRole(overrides = {}) {
    return {
        id: `role-${Date.now()}`,
        name: 'TestRole',
        color: 0xFF0000,
        hexColor: '#FF0000',
        position: 1,
        managed: false,
        ...overrides
    };
}

/**
 * Creates a mock Discord scheduled event
 */
function createMockScheduledEvent(overrides = {}) {
    const subscribers = createMockCollection();
    return {
        id: `event-${Date.now()}`,
        name: 'Test Event',
        description: 'Test event description',
        scheduledStartTime: new Date(Date.now() + 3600000),
        scheduledEndTime: null,
        url: 'https://discord.com/events/guild-123/event-123',
        fetchSubscribers: jest.fn().mockResolvedValue(subscribers),
        delete: jest.fn().mockResolvedValue(undefined),
        // Helper to add interested users for testing
        _addSubscriber: function(userId) {
            subscribers.set(userId, { user: { id: userId } });
        },
        ...overrides
    };
}

/**
 * Creates a mock Discord guild
 */
function createMockGuild(overrides = {}) {
    const scheduledEventsCache = new Map();
    return {
        id: 'guild-123',
        name: 'Test Guild',
        roles: {
            cache: new Map(),
            create: jest.fn().mockResolvedValue(createMockRole()),
            fetch: jest.fn().mockResolvedValue(new Map())
        },
        members: {
            cache: new Map(),
            fetch: jest.fn().mockResolvedValue(createMockMember())
        },
        channels: {
            cache: new Map()
        },
        scheduledEvents: {
            cache: scheduledEventsCache,
            create: jest.fn().mockImplementation((options) => {
                const event = createMockScheduledEvent({
                    id: `event-${Date.now()}`,
                    name: options.name,
                    description: options.description,
                    scheduledStartTime: options.scheduledStartTime,
                    scheduledEndTime: options.scheduledEndTime,
                    url: `https://discord.com/events/guild-123/event-${Date.now()}`
                });
                scheduledEventsCache.set(event.id, event);
                return Promise.resolve(event);
            }),
            fetch: jest.fn().mockImplementation((eventId) => {
                const event = scheduledEventsCache.get(eventId);
                if (event) return Promise.resolve(event);
                const error = new Error('Unknown Guild Scheduled Event');
                error.code = 10070;
                return Promise.reject(error);
            }),
            delete: jest.fn().mockResolvedValue(undefined)
        },
        ...overrides
    };
}

module.exports = {
    createMockInteraction,
    createMockMessage,
    createMockMember,
    createMockChannel,
    createMockRole,
    createMockGuild,
    createMockCollection,
    createMockScheduledEvent
};
