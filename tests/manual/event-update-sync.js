/**
 * Manual Test: Event Update Sync
 *
 * This script tests that edits made via Discord UI are synced to our scheduler:
 * 1. Creates a Discord Scheduled Event
 * 2. Waits for you to edit it via Discord UI
 * 3. Verifies the changes were synced to our scheduler items
 *
 * Usage:
 *   node tests/manual/event-update-sync.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } = require('discord.js');
const readline = require('readline');
const scheduler = require('../../lib/scheduler');

// Hardcoded test parameters
const GUILD_ID = '796874048281247825';
const CHANNEL_ID = '1078444159741997096';

function waitForEnter(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
}

async function runTest() {
    console.log('=== Event Update Sync Test ===\n');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildScheduledEvents
        ]
    });

    let scheduledEvent = null;
    let eventItemId = null;
    let reminderItemId = null;

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

        // Set up event listener for updates
        client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
            console.log('\n   [EVENT UPDATE DETECTED]');
            console.log(`   Old name: ${oldEvent?.name}`);
            console.log(`   New name: ${newEvent?.name}`);
            console.log(`   Old start: ${oldEvent?.scheduledStartTime?.toLocaleString()}`);
            console.log(`   New start: ${newEvent?.scheduledStartTime?.toLocaleString()}`);

            // Call our handler
            await scheduler.handleScheduledEventUpdate(oldEvent, newEvent);
        });

        // Create the event
        const startTime = new Date(Date.now() + 3600000); // 1 hour from now
        console.log(`\n2. Creating Discord Scheduled Event...`);
        console.log(`   Event starts at: ${startTime.toLocaleString()}`);

        scheduledEvent = await guild.scheduledEvents.create({
            name: 'Test Event - EDIT ME',
            description: 'Original description - edit this too!',
            scheduledStartTime: startTime,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.Voice,
            channel: channel.id
        });

        console.log(`   Event created: ${scheduledEvent.url}`);

        // Save event and event_reminder to scheduler
        console.log('\n3. Creating scheduler items...');
        const data = scheduler.loadScheduledItems(GUILD_ID);

        const eventItem = {
            id: scheduler.getNextItemId(data),
            type: 'event',
            guildId: GUILD_ID,
            channelId: CHANNEL_ID,
            creatorId: client.user.id,
            scheduledEventId: scheduledEvent.id,
            eventName: 'Test Event - EDIT ME',
            description: 'Original description - edit this too!',
            triggerAt: startTime.toISOString(),
            recurring: null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };
        data.items.push(eventItem);
        eventItemId = eventItem.id;

        const reminderItem = {
            id: scheduler.getNextItemId(data),
            type: 'event_reminder',
            guildId: GUILD_ID,
            channelId: CHANNEL_ID,
            creatorId: client.user.id,
            scheduledEventId: scheduledEvent.id,
            eventName: 'Test Event - EDIT ME',
            remindBeforeMs: 1800000, // 30 minutes
            triggerAt: new Date(startTime.getTime() - 1800000).toISOString(),
            recurring: null,
            createdDate: new Date().toISOString(),
            lastTriggered: null,
            active: true
        };
        data.items.push(reminderItem);
        reminderItemId = reminderItem.id;

        scheduler.saveScheduledItems(GUILD_ID, data);
        console.log(`   Event item #${eventItem.id} created`);
        console.log(`   Reminder item #${reminderItem.id} created`);

        // Show current state
        console.log('\n4. Current scheduler state:');
        const currentData = scheduler.loadScheduledItems(GUILD_ID);
        const currentEvent = currentData.items.find(i => i.id === eventItemId);
        const currentReminder = currentData.items.find(i => i.id === reminderItemId);
        console.log(`   Event name: "${currentEvent.eventName}"`);
        console.log(`   Event description: "${currentEvent.description || 'none'}"`);
        console.log(`   Event triggerAt: ${new Date(currentEvent.triggerAt).toLocaleString()}`);
        console.log(`   Reminder triggerAt: ${new Date(currentReminder.triggerAt).toLocaleString()}`);

        // Wait for user to edit
        console.log('\n========================================');
        console.log('NOW GO EDIT THE EVENT IN DISCORD!');
        console.log(`Event URL: ${scheduledEvent.url}`);
        console.log('');
        console.log('Try changing:');
        console.log('  - Event name');
        console.log('  - Description');
        console.log('  - Start time');
        console.log('  - Cover image');
        console.log('========================================\n');

        await waitForEnter('Press ENTER after you\'ve edited the event...');

        // Check the synced state
        console.log('\n5. Checking synced scheduler state...');
        const syncedData = scheduler.loadScheduledItems(GUILD_ID);
        const syncedEvent = syncedData.items.find(i => i.id === eventItemId);
        const syncedReminder = syncedData.items.find(i => i.id === reminderItemId);

        console.log('\n   BEFORE -> AFTER:');
        console.log(`   Event name: "${eventItem.eventName}" -> "${syncedEvent?.eventName}"`);
        console.log(`   Event description: "${eventItem.description || 'none'}" -> "${syncedEvent?.description || 'none'}"`);
        console.log(`   Event triggerAt: ${new Date(eventItem.triggerAt).toLocaleString()} -> ${syncedEvent ? new Date(syncedEvent.triggerAt).toLocaleString() : 'N/A'}`);
        console.log(`   Reminder name: "${reminderItem.eventName}" -> "${syncedReminder?.eventName}"`);
        console.log(`   Reminder triggerAt: ${new Date(reminderItem.triggerAt).toLocaleString()} -> ${syncedReminder ? new Date(syncedReminder.triggerAt).toLocaleString() : 'N/A'}`);
        console.log(`   Cover image: ${syncedEvent?.coverImageUrl || 'none'}`);

        // Verify changes
        console.log('\n6. Verification:');
        let passed = 0;
        let failed = 0;

        if (syncedEvent?.eventName !== eventItem.eventName) {
            console.log('   ✓ Event name was synced');
            passed++;
        } else {
            console.log('   ✗ Event name was NOT changed (did you edit it?)');
            failed++;
        }

        if (syncedReminder?.eventName !== reminderItem.eventName) {
            console.log('   ✓ Reminder name was synced');
            passed++;
        } else {
            console.log('   ✗ Reminder name was NOT synced');
            failed++;
        }

        if (syncedEvent?.triggerAt !== eventItem.triggerAt) {
            console.log('   ✓ Event start time was synced');
            passed++;
        } else {
            console.log('   - Event start time unchanged (may not have been edited)');
        }

        if (syncedReminder?.triggerAt !== reminderItem.triggerAt) {
            console.log('   ✓ Reminder trigger time was recalculated');
            passed++;
        } else {
            console.log('   - Reminder trigger time unchanged (start time may not have been edited)');
        }

        console.log(`\n   Results: ${passed} synced, ${failed} failed`);

    } catch (error) {
        console.error('\nError:', error);
    } finally {
        // Cleanup
        console.log('\n7. Cleaning up...');

        if (scheduledEvent) {
            try {
                await scheduledEvent.delete();
                console.log('   Event deleted from Discord');
            } catch (e) {
                console.log('   Could not delete event (may already be deleted)');
            }
        }

        // Remove scheduler items
        if (eventItemId || reminderItemId) {
            const cleanData = scheduler.loadScheduledItems(GUILD_ID);
            cleanData.items = cleanData.items.filter(i =>
                i.id !== eventItemId && i.id !== reminderItemId
            );
            scheduler.saveScheduledItems(GUILD_ID, cleanData);
            console.log('   Scheduler items removed');
        }

        console.log('\n=== Test Complete ===');
        client.destroy();
        process.exit(0);
    }
}

runTest();
