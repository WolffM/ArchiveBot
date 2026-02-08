const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');
const permissions = require('./permissions');
const { createLogger } = require('../utils/logger');
const { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventRecurrenceRuleFrequency } = require('discord.js');

const log = createLogger('scheduler');

// Constants
const SCHEDULER_DIR = path.join(__dirname, '..', 'Output');
const CHECK_INTERVAL = 60000; // Check every 60 seconds

// In-memory references
let discordClient = null;
let checkInterval = null;
let isChecking = false; // Lock to prevent concurrent checks

// ============ File I/O Functions ============

function getScheduleFilePath(guildId) {
    return path.join(SCHEDULER_DIR, guildId, 'scheduled.json');
}

function ensureGuildDirectory(guildId) {
    const guildPath = path.join(SCHEDULER_DIR, guildId);
    helper.ensureDirectoryExists(guildPath);
    return guildPath;
}

function loadScheduledItems(guildId) {
    ensureGuildDirectory(guildId);
    const filePath = getScheduleFilePath(guildId);

    if (!fs.existsSync(filePath)) {
        const initialData = { items: [], lastUpdated: new Date().toISOString() };
        saveScheduledItems(guildId, initialData);
        return initialData;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveScheduledItems(guildId, data) {
    ensureGuildDirectory(guildId);
    const filePath = getScheduleFilePath(guildId);
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============ ID Generation ============

function getNextItemId(data) {
    if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
        return 1;
    }
    const validIds = data.items
        .map(item => parseInt(item.id))
        .filter(id => !isNaN(id));
    return Math.max(...validIds, 0) + 1;
}

// ============ DateTime Parsing ============

/**
 * Parse a time string into hours (24h) and minutes
 * Supports: "10:00", "4:00", "4am", "4pm", "4:30am", "4:30pm", "16:00"
 * Returns { hours, minutes } or null if invalid
 */
function parseTimeString(timeStr) {
    if (!timeStr) return null;

    const normalized = timeStr.trim().toLowerCase();

    // Match "4am", "4pm", "10am", "10pm" (no minutes)
    const ampmNoMinMatch = normalized.match(/^(\d{1,2})\s*(am|pm)$/);
    if (ampmNoMinMatch) {
        let hours = parseInt(ampmNoMinMatch[1]);
        const period = ampmNoMinMatch[2];

        if (hours < 1 || hours > 12) return null;

        if (period === 'am') {
            hours = hours === 12 ? 0 : hours;
        } else {
            hours = hours === 12 ? 12 : hours + 12;
        }

        return { hours, minutes: 0 };
    }

    // Match "4:30am", "4:30pm", "10:30am", "10:30pm"
    const ampmWithMinMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (ampmWithMinMatch) {
        let hours = parseInt(ampmWithMinMatch[1]);
        const minutes = parseInt(ampmWithMinMatch[2]);
        const period = ampmWithMinMatch[3];

        if (hours < 1 || hours > 12 || minutes > 59) return null;

        if (period === 'am') {
            hours = hours === 12 ? 0 : hours;
        } else {
            hours = hours === 12 ? 12 : hours + 12;
        }

        return { hours, minutes };
    }

    // Match 24h format: "10:00", "4:00", "16:30" (1 or 2 digit hour)
    const time24Match = normalized.match(/^(\d{1,2}):(\d{2})$/);
    if (time24Match) {
        const hours = parseInt(time24Match[1]);
        const minutes = parseInt(time24Match[2]);

        if (hours > 23 || minutes > 59) return null;

        return { hours, minutes };
    }

    return null;
}

/**
 * Parse datetime string in flexible formats:
 * - "2026-01-20 10:00" or "2026-01-20T10:00" - full datetime
 * - "10:00", "4:00" - today at that time (or tomorrow if time passed)
 * - "4am", "4pm", "4:30am", "4:30pm" - 12-hour format
 * - "tomorrow 10:00" or "tomorrow 4pm" - tomorrow at that time
 * Returns Date object or null if invalid
 */
function parseDateTime(input) {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim().replace(/^["']+|["']+$/g, '').trim();

    // Full datetime: "2026-01-20 10:00" or "2026-01-20T10:00"
    const fullMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[\sT](.+)$/);
    if (fullMatch) {
        const time = parseTimeString(fullMatch[2]);
        if (time) {
            const date = new Date(`${fullMatch[1]}T00:00:00`);
            date.setHours(time.hours, time.minutes, 0, 0);
            if (!isNaN(date.getTime())) return date;
        }
    }

    // "tomorrow <time>"
    const tomorrowMatch = trimmed.match(/^tomorrow\s+(.+)$/i);
    if (tomorrowMatch) {
        const time = parseTimeString(tomorrowMatch[1]);
        if (time) {
            const date = new Date();
            date.setDate(date.getDate() + 1);
            date.setHours(time.hours, time.minutes, 0, 0);
            return date;
        }
    }

    // Just time: "10:00", "4:00", "4am", "4pm", "4:30am", etc.
    const time = parseTimeString(trimmed);
    if (time) {
        const now = new Date();
        const date = new Date(now);
        date.setHours(time.hours, time.minutes, 0, 0);

        // If time has passed today, schedule for tomorrow
        if (date <= now) {
            date.setDate(date.getDate() + 1);
        }
        return date;
    }

    return null;
}

/**
 * Parse relative time string like "3h", "30m", "1d", "2w"
 * Returns Date object or null if invalid
 */
function parseRelativeTime(input) {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();

    // Match patterns like: 30s, 3h, 30m, 1d, 2w
    const match = trimmed.match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)$/);
    if (match) {
        const [, amount, unit] = match;
        const num = parseInt(amount);
        const now = new Date();

        if (unit.startsWith('s')) {
            now.setSeconds(now.getSeconds() + num);
        } else if (unit.startsWith('m')) {
            now.setMinutes(now.getMinutes() + num);
        } else if (unit.startsWith('h')) {
            now.setHours(now.getHours() + num);
        } else if (unit.startsWith('d')) {
            now.setDate(now.getDate() + num);
        } else if (unit.startsWith('w')) {
            now.setDate(now.getDate() + (num * 7));
        }

        return now;
    }

    // Match compound patterns like "1h30m" or "2h 30m"
    const compoundMatch = trimmed.match(/^(\d+)\s*h(?:rs?|ours?)?\s*(\d+)\s*m(?:ins?|inutes?)?$/);
    if (compoundMatch) {
        const [, hours, minutes] = compoundMatch;
        const now = new Date();
        now.setHours(now.getHours() + parseInt(hours));
        now.setMinutes(now.getMinutes() + parseInt(minutes));
        return now;
    }

    return null;
}

/**
 * Format relative time for display
 */
function formatRelativeTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        const remainingHours = hours % 24;
        return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    if (hours > 0) {
        const remainingMins = minutes % 60;
        return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
    }
    if (minutes > 0) {
        const remainingSecs = seconds % 60;
        return remainingSecs > 0 ? `${minutes}m ${remainingSecs}s` : `${minutes}m`;
    }
    return `${seconds}s`;
}

/**
 * Parse recurring pattern: 1d, every1d, 1w, every1w, 1m, every1m, 1y, every1y
 * Returns normalized pattern or null
 */
function parseRecurring(input) {
    if (!input) return null;

    // Match "1d" or "every1d" format (every prefix is optional)
    const match = input.toLowerCase().match(/^(?:every)?(\d+)(d|w|m|y)$/);
    if (!match) return null;

    const [, count, unit] = match;
    return { count: parseInt(count), unit };
}

/**
 * Calculate next trigger time based on recurring pattern
 */
function calculateNextTrigger(currentTrigger, recurring) {
    if (!recurring) return null;

    const pattern = typeof recurring === 'string' ? parseRecurring(recurring) : recurring;
    if (!pattern) return null;

    const next = new Date(currentTrigger);

    switch (pattern.unit) {
        case 'd':
            next.setDate(next.getDate() + pattern.count);
            break;
        case 'w':
            next.setDate(next.getDate() + (pattern.count * 7));
            break;
        case 'm':
            next.setMonth(next.getMonth() + pattern.count);
            break;
        case 'y':
            next.setFullYear(next.getFullYear() + pattern.count);
            break;
        default:
            return null;
    }

    return next.toISOString();
}

/**
 * Format recurring pattern for display
 */
function formatRecurring(recurring) {
    if (!recurring) return 'One-time';

    const pattern = typeof recurring === 'string' ? parseRecurring(recurring) : recurring;
    if (!pattern) return recurring;

    const units = { d: 'day', w: 'week', m: 'month', y: 'year' };
    const unit = units[pattern.unit] || pattern.unit;

    if (pattern.count === 1) {
        return `Every ${unit}`;
    }
    return `Every ${pattern.count} ${unit}s`;
}

// ============ Scheduler Functions ============

function initializeScheduler(client) {
    discordClient = client;

    if (checkInterval) {
        clearInterval(checkInterval);
    }

    checkInterval = setInterval(() => checkAllItems(), CHECK_INTERVAL);

    // Initial check on startup
    checkAllItems();

    log.success('initialize', { interval: CHECK_INTERVAL });
}

function stopScheduler() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
    log.success('stop', { message: 'Scheduler stopped' });
}

async function checkAllItems() {
    if (!discordClient) {
        log.warn('checkAllItems', { reason: 'Discord client not initialized' });
        return;
    }

    // Prevent concurrent checks (race condition protection)
    if (isChecking) {
        log.debug('checkAllItems', { reason: 'Already checking, skipping' });
        return;
    }

    isChecking = true;
    try {
        const now = new Date();

        for (const guild of discordClient.guilds.cache.values()) {
            try {
                await checkGuildItems(guild, now);
            } catch (error) {
                log.error('checkGuildItems', error, { guildId: guild.id });
            }
        }
    } finally {
        isChecking = false;
    }
}

async function checkGuildItems(guild, now) {
    const data = loadScheduledItems(guild.id);
    let modified = false;

    for (const item of data.items) {
        if (!item.active) continue;

        const triggerTime = new Date(item.triggerAt);

        if (triggerTime <= now) {
            try {
                await fireItem(guild, item);
                item.lastTriggered = now.toISOString();

                // Calculate next trigger or deactivate one-time items
                const nextTrigger = calculateNextTrigger(item.triggerAt, item.recurring);
                if (nextTrigger) {
                    item.triggerAt = nextTrigger;
                } else {
                    item.active = false;
                }

                modified = true;
            } catch (error) {
                log.error('fireItem', error, { itemId: item.id, type: item.type, guildId: guild.id });

                // Deactivate item if channel or event no longer exists
                if (error.code === 10003 || error.code === 10070) {
                    // 10003 = Unknown Channel, 10070 = Unknown Guild Scheduled Event
                    item.active = false;
                    modified = true;
                    const reason = error.code === 10003 ? 'Channel no longer exists' : 'Event no longer exists';
                    log.warn('deactivateItem', { itemId: item.id, reason });
                }
            }
        }
    }

    if (modified) {
        saveScheduledItems(guild.id, data);
    }
}

async function fireItem(guild, item) {
    const channel = await discordClient.channels.fetch(item.channelId);

    if (!channel) {
        throw { code: 10003, message: 'Channel not found' };
    }

    // Different formatting based on type
    let content;
    let allowedMentions = { parse: [] };

    if (item.type === 'personal') {
        // Personal reminder - mention only the creator and link to message
        content = `<@${item.creatorId}> **Reminder:** ${item.messageLink}`;
        allowedMentions = { users: [item.creatorId] };
    } else if (item.type === 'event_reminder') {
        // Event reminder - mention interested users + creator
        const { content: eventContent, allowedMentions: eventMentions } = await buildEventReminderMessage(guild, item);
        content = eventContent;
        allowedMentions = eventMentions;
    } else if (item.type === 'event') {
        content = `**Event:** ${item.message}`;
    } else {
        // Regular reminder - @everyone
        content = `@everyone **Reminder:** ${item.message}`;
        allowedMentions = { parse: ['everyone'] };
    }

    await channel.send({ content, allowedMentions });

    log.success('fireItem', {
        itemId: item.id,
        type: item.type,
        channelId: item.channelId,
        guildId: item.guildId,
        recurring: item.recurring || 'one-time'
    });
}

/**
 * Build the message content for an event reminder
 * Fetches interested users from the scheduled event
 */
async function buildEventReminderMessage(guild, item) {
    const userIds = new Set([item.creatorId]); // Always include creator

    try {
        // Try to fetch the scheduled event and its subscribers
        const scheduledEvent = await guild.scheduledEvents.fetch(item.scheduledEventId);
        if (scheduledEvent) {
            const subscribers = await scheduledEvent.fetchSubscribers();
            for (const [userId] of subscribers) {
                userIds.add(userId);
            }
        }
    } catch (error) {
        // Event may have been deleted or we can't fetch subscribers
        log.warn('buildEventReminderMessage', {
            reason: 'Could not fetch event or subscribers',
            eventId: item.scheduledEventId,
            error: error.message
        });
    }

    // Format time until event
    const timeUntil = formatRelativeTime(item.remindBeforeMs);

    // Build mention list
    const mentions = Array.from(userIds).map(id => `<@${id}>`).join(' ');

    const content = `${mentions}\n\n**Reminder:** Event "${item.eventName}" starts in ${timeUntil}!`;
    const allowedMentions = { users: Array.from(userIds) };

    return { content, allowedMentions };
}

// ============ Command Handlers ============

async function handleAddCommand(interaction) {
    const hasAccess = await permissions.checkTaskAccessWithRoles(
        interaction.user.id,
        interaction.guild
    );

    if (!hasAccess) {
        log.fail('handleAddCommand', {
            reason: 'Permission denied',
            userId: interaction.user.id,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: 'You do not have permission to add scheduled items.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: false });

    try {
        const type = interaction.options.getString('type');
        const at = interaction.options.getString('at');
        const recurring = interaction.options.getString('recurring');
        const message = interaction.options.getString('message');

        // Validation
        if (!message) {
            await interaction.editReply('Please provide a message.');
            return;
        }

        // Try relative time first (e.g., "2h", "30m"), then absolute datetime
        let triggerDate = parseRelativeTime(at) || parseDateTime(at);
        if (!triggerDate) {
            await interaction.editReply(
                'Invalid time format. Use:\n' +
                '• `2h` - 2 hours from now\n' +
                '• `30m` - 30 minutes from now\n' +
                '• `1d` - 1 day from now\n' +
                '• `4:00` or `16:00` - today/tomorrow at that time\n' +
                '• `4am` or `4pm` - 12-hour format\n' +
                '• `2026-01-20 10:00` - specific date and time'
            );
            return;
        }

        // Validate recurring pattern if provided
        if (recurring && !parseRecurring(recurring)) {
            await interaction.editReply(
                'Invalid recurring format. Use:\n' +
                '• `1d` - every day\n' +
                '• `1w` - every week\n' +
                '• `2w` - every 2 weeks\n' +
                '• `1m` - every month\n' +
                '• `1y` - every year'
            );
            return;
        }

        const data = loadScheduledItems(interaction.guild.id);

        const newItem = {
            id: getNextItemId(data),
            type: type,
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            creatorId: interaction.user.id,
            message: message,
            triggerAt: triggerDate.toISOString(),
            recurring: recurring || null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };

        data.items.push(newItem);
        saveScheduledItems(interaction.guild.id, data);

        log.success('handleAddCommand', {
            itemId: newItem.id,
            type: type,
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            userId: interaction.user.id,
            recurring: recurring || 'one-time',
            triggerAt: triggerDate.toISOString()
        });

        const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
        await interaction.editReply(
            `${typeLabel} #${newItem.id} created!\n` +
            `**Message:** ${message}\n` +
            `**Next trigger:** ${triggerDate.toLocaleString()}\n` +
            `**Recurring:** ${formatRecurring(recurring)}\n` +
            `**Channel:** <#${interaction.channel.id}>`
        );

    } catch (error) {
        log.error('handleAddCommand', error, {
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });
        await interaction.editReply(`Error: ${error.message}`);
    }
}

async function handleRemoveCommand(interaction) {
    const hasAccess = await permissions.checkTaskAccessWithRoles(
        interaction.user.id,
        interaction.guild
    );

    if (!hasAccess) {
        log.fail('handleRemoveCommand', {
            reason: 'Permission denied',
            userId: interaction.user.id,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: 'You do not have permission to remove scheduled items.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: false });

    try {
        const type = interaction.options.getString('type');
        const idInput = interaction.options.getString('id');

        if (!idInput) {
            log.fail('handleRemoveCommand', {
                reason: 'No ID provided',
                userId: interaction.user.id,
                guildId: interaction.guild.id
            });
            await interaction.editReply('Please provide an ID to remove.');
            return;
        }

        // Parse multiple IDs (e.g., "6,7,8" or just "5")
        const ids = idInput.split(',')
            .map(s => parseInt(s.trim()))
            .filter(id => !isNaN(id));

        if (ids.length === 0) {
            await interaction.editReply('Invalid ID format. Use a number or comma-separated numbers (e.g., "5" or "6,7,8").');
            return;
        }

        const data = loadScheduledItems(interaction.guild.id);
        const results = [];
        const notFound = [];
        const deletedDiscordEvents = new Set();

        for (const id of ids) {
            const index = data.items.findIndex(item =>
                item.id === id && (!type || item.type === type)
            );

            if (index === -1) {
                notFound.push(id);
                continue;
            }

            const removed = data.items.splice(index, 1)[0];

            // If this is an event with a Discord Scheduled Event, delete it
            if (removed.scheduledEventId && !deletedDiscordEvents.has(removed.scheduledEventId)) {
                try {
                    const scheduledEvent = await interaction.guild.scheduledEvents.fetch(removed.scheduledEventId);
                    if (scheduledEvent) {
                        await scheduledEvent.delete();
                        deletedDiscordEvents.add(removed.scheduledEventId);
                        log.success('handleRemoveCommand', {
                            action: 'Deleted Discord Scheduled Event',
                            eventId: removed.scheduledEventId,
                            guildId: interaction.guild.id
                        });
                    }
                } catch (eventError) {
                    if (eventError.code !== 10070) {
                        log.warn('handleRemoveCommand', {
                            reason: 'Failed to delete Discord event',
                            eventId: removed.scheduledEventId,
                            error: eventError.message
                        });
                    }
                }
            }

            // If this is an event, also remove any connected event_reminder items
            if (removed.type === 'event' && removed.scheduledEventId) {
                const reminderIndex = data.items.findIndex(item =>
                    item.type === 'event_reminder' && item.scheduledEventId === removed.scheduledEventId
                );
                if (reminderIndex !== -1) {
                    const removedReminder = data.items.splice(reminderIndex, 1)[0];
                    log.success('handleRemoveCommand', {
                        action: 'Removed connected event_reminder',
                        reminderId: removedReminder.id,
                        eventId: removed.scheduledEventId,
                        guildId: interaction.guild.id
                    });
                }
            }

            // If this is an event_reminder, also delete the parent event
            if (removed.type === 'event_reminder' && removed.scheduledEventId) {
                const eventIndex = data.items.findIndex(item =>
                    item.type === 'event' && item.scheduledEventId === removed.scheduledEventId
                );
                if (eventIndex !== -1) {
                    const removedEvent = data.items.splice(eventIndex, 1)[0];
                    log.success('handleRemoveCommand', {
                        action: 'Removed parent event',
                        eventId: removedEvent.id,
                        scheduledEventId: removed.scheduledEventId,
                        guildId: interaction.guild.id
                    });
                }

                // Delete the Discord Scheduled Event if not already deleted
                if (!deletedDiscordEvents.has(removed.scheduledEventId)) {
                    try {
                        const scheduledEvent = await interaction.guild.scheduledEvents.fetch(removed.scheduledEventId);
                        if (scheduledEvent) {
                            await scheduledEvent.delete();
                            deletedDiscordEvents.add(removed.scheduledEventId);
                            log.success('handleRemoveCommand', {
                                action: 'Deleted Discord Scheduled Event (via reminder removal)',
                                eventId: removed.scheduledEventId,
                                guildId: interaction.guild.id
                            });
                        }
                    } catch (eventError) {
                        if (eventError.code !== 10070) {
                            log.warn('handleRemoveCommand', {
                                reason: 'Failed to delete Discord event',
                                eventId: removed.scheduledEventId,
                                error: eventError.message
                            });
                        }
                    }
                }
            }

            const typeLabel = removed.type.charAt(0).toUpperCase() + removed.type.slice(1);
            let itemDesc = `${typeLabel} #${id}`;
            if (removed.message) {
                itemDesc += `: "${removed.message}"`;
            } else if (removed.eventName) {
                itemDesc += `: "${removed.eventName}"`;
            }
            results.push(itemDesc);

            log.success('handleRemoveCommand', {
                itemId: id,
                type: removed.type,
                guildId: interaction.guild.id,
                userId: interaction.user.id
            });
        }

        saveScheduledItems(interaction.guild.id, data);

        // Build reply message
        let replyMessage = '';
        if (results.length > 0) {
            replyMessage += `**Removed ${results.length} item(s):**\n${results.map(r => `• ${r}`).join('\n')}`;
            if (deletedDiscordEvents.size > 0) {
                replyMessage += `\n\n${deletedDiscordEvents.size} Discord Scheduled Event(s) deleted.`;
            }
        }
        if (notFound.length > 0) {
            if (replyMessage) replyMessage += '\n\n';
            const typeStr = type ? ` of type "${type}"` : '';
            replyMessage += `**Not found${typeStr}:** ${notFound.map(id => `#${id}`).join(', ')}`;
        }
        if (!replyMessage) {
            replyMessage = 'No items were removed.';
        }
        await interaction.editReply(replyMessage);

    } catch (error) {
        log.error('handleRemoveCommand', error, {
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });
        await interaction.editReply(`Error: ${error.message}`);
    }
}

async function handleShowCommand(interaction) {
    const hasAccess = await permissions.checkTaskAccessWithRoles(
        interaction.user.id,
        interaction.guild
    );

    if (!hasAccess) {
        log.fail('handleShowCommand', {
            reason: 'Permission denied',
            userId: interaction.user.id,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: 'You do not have permission to view scheduled items.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const type = interaction.options.getString('type');
        const data = loadScheduledItems(interaction.guild.id);

        let items = data.items.filter(item => item.active);
        if (type) {
            items = items.filter(item => item.type === type);
        }

        log.success('handleShowCommand', {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            filter: type || 'all',
            itemCount: items.length
        });

        if (items.length === 0) {
            const typeStr = type ? ` ${type}s` : ' items';
            await interaction.editReply(`No active${typeStr} scheduled.`);
            return;
        }

        const itemList = items.map(item => {
            const nextDate = new Date(item.triggerAt);
            const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);

            // Get display name based on item type
            let displayName;
            if (item.type === 'event' || item.type === 'event_reminder') {
                displayName = item.eventName || 'Unnamed event';
            } else if (item.type === 'personal') {
                displayName = item.messageLink || 'Personal reminder';
            } else {
                displayName = item.message || 'No message';
            }

            return `**#${item.id}** [${typeLabel}] - ${displayName}\n` +
                   `  ${formatRecurring(item.recurring)} | Channel: <#${item.channelId}>\n` +
                   `  Next: ${nextDate.toLocaleString()}`;
        }).join('\n\n');

        await interaction.editReply(`**Scheduled Items:**\n\n${itemList}`);

    } catch (error) {
        log.error('handleShowCommand', error, {
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });
        await interaction.editReply(`Error: ${error.message}`);
    }
}

// ============ Message-Based Reminder Handler ============

/**
 * Check if a message is a "remind me" request and handle it
 * Returns true if handled, false otherwise
 */
async function handleMessageReminder(message) {
    // Check for "remind me in X" pattern
    const content = message.content.toLowerCase().trim();
    const match = content.match(/^remind\s*me\s+in\s+(.+)$/i);

    if (!match) {
        return false;
    }

    const timeStr = match[1].trim();
    const triggerDate = parseRelativeTime(timeStr);

    if (!triggerDate) {
        log.fail('handleMessageReminder', {
            reason: 'Invalid time format',
            input: timeStr,
            userId: message.author.id,
            guildId: message.guild.id
        });
        await message.reply({
            content: 'Invalid time format. Try: `remind me in 30s`, `remind me in 3h`, `remind me in 30m`, `remind me in 1d`',
            allowedMentions: { repliedUser: false }
        });
        return true;
    }

    try {
        // Determine the target message - either the replied-to message or the trigger message itself
        let targetMessageId;
        if (message.reference && message.reference.messageId) {
            // User replied to a message - use that as the target
            targetMessageId = message.reference.messageId;
        } else {
            // No reply - use the trigger message itself
            targetMessageId = message.id;
        }

        const messageLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${targetMessageId}`;

        const data = loadScheduledItems(message.guild.id);

        const newItem = {
            id: getNextItemId(data),
            type: 'personal',
            guildId: message.guild.id,
            channelId: message.channel.id,
            creatorId: message.author.id,
            message: null, // Personal reminders use messageLink instead
            messageLink: messageLink,
            triggerAt: triggerDate.toISOString(),
            recurring: null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };

        data.items.push(newItem);
        saveScheduledItems(message.guild.id, data);

        // Acknowledge with thumbs up reaction
        await message.react('👍');

        const timeUntil = triggerDate.getTime() - Date.now();
        log.success('handleMessageReminder', {
            itemId: newItem.id,
            userId: message.author.id,
            guildId: message.guild.id,
            channelId: message.channel.id,
            triggerAt: triggerDate.toISOString(),
            timeUntil: formatRelativeTime(timeUntil),
            isReply: !!message.reference
        });
        return true;

    } catch (error) {
        log.error('handleMessageReminder', error, {
            userId: message.author.id,
            guildId: message.guild.id
        });
        await message.reply({
            content: 'Sorry, something went wrong creating your reminder.',
            allowedMentions: { repliedUser: false }
        });
        return true;
    }
}

// ============ Wrapper Handlers for /reminder and /event Commands ============

async function handleReminderCommand(interaction) {
    // Inject the type so the handler can use it
    const originalGetString = interaction.options.getString.bind(interaction.options);
    interaction.options.getString = (name) => {
        if (name === 'type') return 'reminder';
        return originalGetString(name);
    };
    return handleAddCommand(interaction);
}

async function handleEventCommand(interaction) {
    const hasAccess = await permissions.checkTaskAccessWithRoles(
        interaction.user.id,
        interaction.guild
    );

    if (!hasAccess) {
        log.fail('handleEventCommand', {
            reason: 'Permission denied',
            userId: interaction.user.id,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: 'You do not have permission to create events.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: false });

    try {
        const name = interaction.options.getString('name');
        const startTime = interaction.options.getString('start');
        const eventType = interaction.options.getString('type');
        const channel = interaction.options.getChannel('channel');
        const location = interaction.options.getString('location');
        const endTime = interaction.options.getString('end');
        const description = interaction.options.getString('description');
        const recurring = interaction.options.getString('recurring');
        const remindBefore = interaction.options.getString('remind_before');
        const imageAttachment = interaction.options.getAttachment('image');

        // Parse start time
        const startDate = parseRelativeTime(startTime) || parseDateTime(startTime);
        if (!startDate) {
            await interaction.editReply(
                'Invalid start time format. Use:\n' +
                '• `2h` - 2 hours from now\n' +
                '• `4:00` or `16:00` - today/tomorrow at that time\n' +
                '• `4am` or `4pm` - 12-hour format\n' +
                '• `2026-01-20 10:00` - specific date and time'
            );
            return;
        }

        // Map event type to Discord entity type
        const entityTypeMap = {
            'voice': GuildScheduledEventEntityType.Voice,
            'stage': GuildScheduledEventEntityType.StageInstance,
            'external': GuildScheduledEventEntityType.External
        };
        const entityType = entityTypeMap[eventType];

        // Validate required fields based on event type
        if ((eventType === 'voice' || eventType === 'stage') && !channel) {
            await interaction.editReply(
                `A ${eventType} channel is required for ${eventType} events. Please specify the \`channel\` option.`
            );
            return;
        }

        if (eventType === 'external' && !location) {
            await interaction.editReply(
                'A location is required for external events. Please specify the `location` option.'
            );
            return;
        }

        if (eventType === 'external' && !endTime) {
            await interaction.editReply(
                'An end time is required for external events. Please specify the `end` option.'
            );
            return;
        }

        // Parse end time if provided
        let endDate = null;
        if (endTime) {
            endDate = parseRelativeTime(endTime) || parseDateTime(endTime);
            if (!endDate) {
                await interaction.editReply('Invalid end time format.');
                return;
            }
            if (endDate <= startDate) {
                await interaction.editReply('End time must be after start time.');
                return;
            }
        }

        // Build event options
        const eventOptions = {
            name: name,
            scheduledStartTime: startDate,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: entityType,
            description: description || undefined
        };

        // Add channel for voice/stage events
        if (eventType === 'voice' || eventType === 'stage') {
            eventOptions.channel = channel.id;
        }

        // Add metadata for external events
        if (eventType === 'external') {
            eventOptions.entityMetadata = { location: location };
            eventOptions.scheduledEndTime = endDate;
        }

        // Add cover image if provided (attachment URL)
        if (imageAttachment) {
            eventOptions.image = imageAttachment.url;
        }

        // Add recurrence rule if specified
        if (recurring) {
            const frequencyMap = {
                'daily': GuildScheduledEventRecurrenceRuleFrequency.Daily,
                'weekly': GuildScheduledEventRecurrenceRuleFrequency.Weekly,
                'monthly': GuildScheduledEventRecurrenceRuleFrequency.Monthly,
                'yearly': GuildScheduledEventRecurrenceRuleFrequency.Yearly
            };
            eventOptions.recurrenceRule = {
                startAt: startDate,
                frequency: frequencyMap[recurring],
                interval: 1
            };
        }

        // Validate remind_before if provided
        let remindBeforeMs = null;
        if (remindBefore) {
            // Parse the relative time to get duration in ms
            const now = new Date();
            const futureDate = parseRelativeTime(remindBefore);
            if (!futureDate) {
                await interaction.editReply(
                    'Invalid remind_before format. Use: `30m`, `1h`, `2h`, `1d`, etc.'
                );
                return;
            }
            remindBeforeMs = futureDate.getTime() - now.getTime();
        }

        // Create the scheduled event
        const scheduledEvent = await interaction.guild.scheduledEvents.create(eventOptions);

        // Save event item to scheduler for tracking
        const data = loadScheduledItems(interaction.guild.id);
        const eventChannelId = (eventType === 'external')
            ? interaction.channel.id
            : channel.id;

        // Calculate recurring pattern for scheduler
        let schedulerRecurring = null;
        if (recurring) {
            const recurringMap = {
                'daily': '1d',
                'weekly': '1w',
                'monthly': '1m',
                'yearly': '1y'
            };
            schedulerRecurring = recurringMap[recurring];
        }

        const eventItem = {
            id: getNextItemId(data),
            type: 'event',
            guildId: interaction.guild.id,
            channelId: eventChannelId,
            creatorId: interaction.user.id,
            scheduledEventId: scheduledEvent.id,
            eventName: name,
            triggerAt: startDate.toISOString(),
            recurring: schedulerRecurring,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };

        data.items.push(eventItem);
        saveScheduledItems(interaction.guild.id, data);

        // Create event reminder if remind_before was specified
        let reminderCreated = false;
        if (remindBeforeMs) {
            const reminderTriggerTime = new Date(startDate.getTime() - remindBeforeMs);
            const now = new Date();

            // Determine the channel to post reminder to
            // For voice/stage events, use the same channel (voice channels support text)
            // For external events, use the channel where the command was run
            const reminderChannelId = (eventType === 'external')
                ? interaction.channel.id
                : channel.id;

            // Use the same recurring pattern as the event
            const reminderRecurring = schedulerRecurring;

            // If reminder time is in the past, calculate next occurrence
            let actualTriggerTime = reminderTriggerTime;
            if (reminderTriggerTime <= now && reminderRecurring) {
                // Skip to next occurrence based on recurring pattern
                actualTriggerTime = new Date(calculateNextTrigger(reminderTriggerTime.toISOString(), reminderRecurring));
            }

            // Only create reminder if trigger time is in the future
            if (actualTriggerTime > now) {
                const reminderItem = {
                    id: getNextItemId(data),
                    type: 'event_reminder',
                    guildId: interaction.guild.id,
                    channelId: reminderChannelId,
                    creatorId: interaction.user.id,
                    scheduledEventId: scheduledEvent.id,
                    eventName: name,
                    remindBeforeMs: remindBeforeMs,
                    triggerAt: actualTriggerTime.toISOString(),
                    recurring: reminderRecurring,
                    createdDate: new Date().toISOString(),
                    lastTriggered: null,
                    active: true
                };

                data.items.push(reminderItem);
                saveScheduledItems(interaction.guild.id, data);
                reminderCreated = true;

                log.success('createEventReminder', {
                    reminderId: reminderItem.id,
                    eventId: scheduledEvent.id,
                    eventName: name,
                    triggerAt: actualTriggerTime.toISOString(),
                    remindBefore: remindBefore
                });
            }
        }

        log.success('handleEventCommand', {
            eventId: scheduledEvent.id,
            name: name,
            type: eventType,
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            startTime: startDate.toISOString(),
            recurring: recurring || 'one-time',
            reminderCreated: reminderCreated
        });

        const typeLabel = eventType.charAt(0).toUpperCase() + eventType.slice(1);
        const recurringLabel = recurring ? recurring.charAt(0).toUpperCase() + recurring.slice(1) : null;
        await interaction.editReply(
            `**${typeLabel} Event Created!**\n` +
            `**Name:** ${name}\n` +
            `**Start:** ${startDate.toLocaleString()}\n` +
            (endDate ? `**End:** ${endDate.toLocaleString()}\n` : '') +
            (recurringLabel ? `**Recurring:** ${recurringLabel}\n` : '') +
            (reminderCreated ? `**Reminder:** ${remindBefore} before\n` : '') +
            (description ? `**Description:** ${description}\n` : '') +
            (channel ? `**Channel:** <#${channel.id}>\n` : '') +
            (location ? `**Location:** ${location}\n` : '') +
            `**Event URL:** ${scheduledEvent.url}`
        );

    } catch (error) {
        log.error('handleEventCommand', error, {
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });

        let errorMessage = error.message;
        if (error.code === 50013) {
            errorMessage = 'Bot lacks permission to create scheduled events. Ensure it has the "Manage Events" permission.';
        }

        await interaction.editReply(`Error creating event: ${errorMessage}`);
    }
}

// ============ Discord Event Handlers ============

/**
 * Handle when a Discord Scheduled Event is updated via Discord UI
 * Syncs changes back to our scheduler items
 */
async function handleScheduledEventUpdate(_oldEvent, newEvent) {
    if (!newEvent || !newEvent.guild) return;

    const guildId = newEvent.guild.id;
    const data = loadScheduledItems(guildId);

    // Find scheduler items with this scheduledEventId
    const eventItem = data.items.find(item =>
        item.scheduledEventId === newEvent.id && item.type === 'event'
    );
    const reminderItem = data.items.find(item =>
        item.scheduledEventId === newEvent.id && item.type === 'event_reminder'
    );

    if (!eventItem && !reminderItem) {
        // Not one of our tracked events
        return;
    }

    let modified = false;

    // Track what changed for logging
    const changes = [];

    // Sync event name
    if (eventItem && newEvent.name !== eventItem.eventName) {
        changes.push(`name: "${eventItem.eventName}" -> "${newEvent.name}"`);
        eventItem.eventName = newEvent.name;
        modified = true;
    }
    if (reminderItem && newEvent.name !== reminderItem.eventName) {
        reminderItem.eventName = newEvent.name;
        modified = true;
    }

    // Sync description (store it for future use)
    if (eventItem && newEvent.description !== eventItem.description) {
        changes.push(`description updated`);
        eventItem.description = newEvent.description;
        modified = true;
    }

    // Sync start time
    const newStartTime = newEvent.scheduledStartTime?.toISOString();
    if (eventItem && newStartTime && newStartTime !== eventItem.triggerAt) {
        changes.push(`start: ${new Date(eventItem.triggerAt).toLocaleString()} -> ${newEvent.scheduledStartTime.toLocaleString()}`);
        eventItem.triggerAt = newStartTime;
        modified = true;

        // Also update the reminder trigger time if it exists
        if (reminderItem && reminderItem.remindBeforeMs) {
            const newReminderTime = new Date(newEvent.scheduledStartTime.getTime() - reminderItem.remindBeforeMs);
            reminderItem.triggerAt = newReminderTime.toISOString();
        }
    }

    // Sync location (for external events)
    const newLocation = newEvent.entityMetadata?.location;
    if (eventItem && newLocation !== eventItem.location) {
        changes.push(`location: "${eventItem.location || 'none'}" -> "${newLocation || 'none'}"`);
        eventItem.location = newLocation;
        modified = true;
    }

    // Sync cover image URL
    const newImageUrl = newEvent.coverImageURL({ size: 1024 });
    if (eventItem && newImageUrl !== eventItem.coverImageUrl) {
        changes.push(`cover image updated`);
        eventItem.coverImageUrl = newImageUrl;
        modified = true;
    }

    if (modified) {
        saveScheduledItems(guildId, data);
        log.success('handleScheduledEventUpdate', {
            eventId: newEvent.id,
            guildId: guildId,
            changes: changes
        });
    }
}

/**
 * Handle when a Discord Scheduled Event is deleted via Discord UI
 * Cleans up our scheduler items
 */
async function handleScheduledEventDelete(event) {
    if (!event || !event.guild) return;

    const guildId = event.guild.id;
    const data = loadScheduledItems(guildId);

    // Find and remove any scheduler items with this scheduledEventId
    const removedItems = [];

    data.items = data.items.filter(item => {
        if (item.scheduledEventId === event.id) {
            removedItems.push({ id: item.id, type: item.type });
            return false;
        }
        return true;
    });

    if (removedItems.length > 0) {
        saveScheduledItems(guildId, data);
        log.success('handleScheduledEventDelete', {
            eventId: event.id,
            eventName: event.name,
            guildId: guildId,
            removedItems: removedItems
        });
    }
}

// ============ Module Exports ============

module.exports = {
    handleAddCommand,
    handleReminderCommand,
    handleEventCommand,
    handleRemoveCommand,
    handleShowCommand,
    handleMessageReminder,
    loadScheduledItems,
    saveScheduledItems,
    initializeScheduler,
    stopScheduler,
    // Discord event handlers
    handleScheduledEventUpdate,
    handleScheduledEventDelete,
    // Pure functions for testing
    getNextItemId,
    parseTimeString,
    parseDateTime,
    parseRelativeTime,
    parseRecurring,
    calculateNextTrigger,
    formatRecurring,
    formatRelativeTime,
    // For integration testing
    checkAllItems
};
