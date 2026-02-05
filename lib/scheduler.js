const fs = require('fs');
const path = require('path');
const helper = require('../utils/helper');
const permissions = require('./permissions');
const { createLogger } = require('../utils/logger');

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
 * Parse datetime string in flexible formats:
 * - "2026-01-20 10:00" or "2026-01-20T10:00" - full datetime
 * - "10:00" - today at that time (or tomorrow if time passed)
 * - "tomorrow 10:00" - tomorrow at that time
 * Returns Date object or null if invalid
 */
function parseDateTime(input) {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim();

    // Full datetime: "2026-01-20 10:00" or "2026-01-20T10:00"
    const fullMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2})$/);
    if (fullMatch) {
        const date = new Date(`${fullMatch[1]}T${fullMatch[2]}:00`);
        if (!isNaN(date.getTime())) return date;
    }

    // Just time: "10:00" or "14:30"
    const timeMatch = trimmed.match(/^(\d{2}):(\d{2})$/);
    if (timeMatch) {
        const [, hours, minutes] = timeMatch;
        const now = new Date();
        const date = new Date(now);
        date.setHours(parseInt(hours), parseInt(minutes), 0, 0);

        // If time has passed today, schedule for tomorrow
        if (date <= now) {
            date.setDate(date.getDate() + 1);
        }
        return date;
    }

    // "tomorrow 10:00"
    const tomorrowMatch = trimmed.match(/^tomorrow\s+(\d{2}):(\d{2})$/i);
    if (tomorrowMatch) {
        const [, hours, minutes] = tomorrowMatch;
        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(parseInt(hours), parseInt(minutes), 0, 0);
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

    const trimmed = input.trim().toLowerCase();

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

                if (error.code === 10003) { // Unknown Channel
                    item.active = false;
                    modified = true;
                    log.warn('deactivateItem', { itemId: item.id, reason: 'Channel no longer exists' });
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
                '• `10:00` - today/tomorrow at that time\n' +
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
        const id = interaction.options.getInteger('id');

        if (!id) {
            log.fail('handleRemoveCommand', {
                reason: 'No ID provided',
                userId: interaction.user.id,
                guildId: interaction.guild.id
            });
            await interaction.editReply('Please provide an ID to remove.');
            return;
        }

        const data = loadScheduledItems(interaction.guild.id);
        const index = data.items.findIndex(item =>
            item.id === id && (!type || item.type === type)
        );

        if (index === -1) {
            log.fail('handleRemoveCommand', {
                reason: 'Item not found',
                itemId: id,
                type: type || 'any',
                guildId: interaction.guild.id
            });
            const typeStr = type ? ` of type "${type}"` : '';
            await interaction.editReply(`Item #${id}${typeStr} not found.`);
            return;
        }

        const removed = data.items.splice(index, 1)[0];
        saveScheduledItems(interaction.guild.id, data);

        log.success('handleRemoveCommand', {
            itemId: id,
            type: removed.type,
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });

        const typeLabel = removed.type.charAt(0).toUpperCase() + removed.type.slice(1);
        await interaction.editReply(`Removed ${typeLabel} #${id}: "${removed.message}"`);

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
            return `**#${item.id}** [${typeLabel}] - ${item.message}\n` +
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
    // Inject the type so the handler can use it
    const originalGetString = interaction.options.getString.bind(interaction.options);
    interaction.options.getString = (name) => {
        if (name === 'type') return 'event';
        return originalGetString(name);
    };
    return handleAddCommand(interaction);
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
    // Pure functions for testing
    getNextItemId,
    parseDateTime,
    parseRelativeTime,
    parseRecurring,
    calculateNextTrigger,
    formatRecurring,
    formatRelativeTime
};
