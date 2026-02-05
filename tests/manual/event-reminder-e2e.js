/**
 * Manual E2E Test: Event Reminder with Interested Users
 *
 * This script tests the full flow against real Discord:
 * 1. Creates a Discord Scheduled Event
 * 2. Waits for you to click "Interested"
 * 3. Fires the event_reminder
 * 4. Verifies you get mentioned
 *
 * Usage:
 *   node tests/manual/event-reminder-e2e.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } = require('discord.js');
const scheduler = require('../../lib/scheduler');

// Hardcoded test parameters
const GUILD_ID = '796874048281247825';
const CHANNEL_ID = '1078444159741997096';

const EVENT_START_DELAY = 30000;  // Event starts 30s from now
const REMINDER_BEFORE = 10000;    // Reminder fires 10s before event (so 20s from now)
const INTEREST_WINDOW = 15000;    // Give user 15s to click "Interested"

async function runTest() {
    console.log('=== Event Reminder E2E Test ===\n');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildScheduledEvents,
            GatewayIntentBits.GuildMessages
        ]
    });

    try {
        // Login
        console.log('1. Logging in to Discord...');
        await client.login(process.env.DISCORD_TOKEN);
        console.log(`   Logged in as ${client.user.tag}`);

        // Get guild and channel
        const guild = await client.guilds.fetch(GUILD_ID);
        const channel = await client.channels.fetch(CHANNEL_ID);
        console.log(`   Guild: ${guild.name}`);
        console.log(`   Channel: ${channel.name}`);

        // Initialize scheduler
        console.log('\n2. Initializing scheduler...');
        scheduler.initializeScheduler(client);

        // Create the event
        const startTime = new Date(Date.now() + EVENT_START_DELAY);
        console.log(`\n3. Creating Discord Scheduled Event...`);
        console.log(`   Event starts at: ${startTime.toLocaleTimeString()}`);

        const scheduledEvent = await guild.scheduledEvents.create({
            name: 'E2E Test Event',
            description: 'Testing event_reminder functionality',
            scheduledStartTime: startTime,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.Voice,
            channel: channel.id
        });

        console.log(`   Event created: ${scheduledEvent.url}`);

        // Save event and event_reminder to scheduler
        console.log('\n4. Creating scheduler items...');
        const data = scheduler.loadScheduledItems(GUILD_ID);

        const eventItem = {
            id: scheduler.getNextItemId(data),
            type: 'event',
            guildId: GUILD_ID,
            channelId: CHANNEL_ID,
            creatorId: client.user.id,
            scheduledEventId: scheduledEvent.id,
            eventName: 'E2E Test Event',
            triggerAt: startTime.toISOString(),
            recurring: null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };
        data.items.push(eventItem);

        const reminderTriggerTime = new Date(startTime.getTime() - REMINDER_BEFORE);
        const reminderItem = {
            id: scheduler.getNextItemId(data),
            type: 'event_reminder',
            guildId: GUILD_ID,
            channelId: CHANNEL_ID,
            creatorId: client.user.id,
            scheduledEventId: scheduledEvent.id,
            eventName: 'E2E Test Event',
            remindBeforeMs: REMINDER_BEFORE,
            triggerAt: reminderTriggerTime.toISOString(),
            recurring: null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };
        data.items.push(reminderItem);

        scheduler.saveScheduledItems(GUILD_ID, data);
        console.log(`   Event item #${eventItem.id} created`);
        console.log(`   Reminder item #${reminderItem.id} created (fires at ${reminderTriggerTime.toLocaleTimeString()})`);

        // Wait for user to click interested
        console.log(`\n5. >>> CLICK "INTERESTED" ON THE EVENT NOW! <<<`);
        console.log(`   Event URL: ${scheduledEvent.url}`);
        console.log(`   You have ${INTEREST_WINDOW / 1000} seconds...`);

        await new Promise(resolve => setTimeout(resolve, INTEREST_WINDOW));

        // Check who's interested
        console.log('\n6. Checking interested users...');
        const updatedEvent = await guild.scheduledEvents.fetch(scheduledEvent.id);
        const subscribers = await updatedEvent.fetchSubscribers();
        console.log(`   Found ${subscribers.size} interested user(s):`);
        for (const [userId, data] of subscribers) {
            console.log(`   - ${data.user.username} (${userId})`);
        }

        // Wait for reminder to fire
        const timeUntilReminder = reminderTriggerTime.getTime() - Date.now();
        if (timeUntilReminder > 0) {
            console.log(`\n7. Waiting ${Math.ceil(timeUntilReminder / 1000)}s for reminder to fire...`);
            await new Promise(resolve => setTimeout(resolve, timeUntilReminder + 2000)); // +2s buffer
        }

        // Manually trigger check to ensure it fires
        console.log('\n8. Triggering scheduler check...');
        await scheduler.checkAllItems();

        // Verify
        console.log('\n9. Verifying...');
        const finalData = scheduler.loadScheduledItems(GUILD_ID);
        const firedReminder = finalData.items.find(i => i.id === reminderItem.id);

        if (!firedReminder || !firedReminder.active) {
            console.log('   ✓ Reminder fired and deactivated (one-time)');
        } else if (firedReminder.lastTriggered) {
            console.log('   ✓ Reminder fired (recurring)');
        } else {
            console.log('   ✗ Reminder may not have fired - check the channel');
        }

        // Cleanup
        console.log('\n10. Cleaning up...');
        await scheduledEvent.delete();
        console.log('    Event deleted');

        // Remove scheduler items
        const cleanData = scheduler.loadScheduledItems(GUILD_ID);
        cleanData.items = cleanData.items.filter(i =>
            i.id !== eventItem.id && i.id !== reminderItem.id
        );
        scheduler.saveScheduledItems(GUILD_ID, cleanData);
        console.log('    Scheduler items removed');

        console.log('\n=== Test Complete ===');
        console.log('Check the voice channel for the reminder message!');

    } catch (error) {
        console.error('\nError:', error);
    } finally {
        scheduler.stopScheduler();
        client.destroy();
        process.exit(0);
    }
}

runTest();
