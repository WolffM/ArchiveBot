/**
 * Manual E2E Test: Archive Channel Full Pipeline
 *
 * Tests the complete archive flow against a real Discord server:
 * 1. Connects to Discord
 * 2. Posts test messages (text, embed, reply, reaction)
 * 3. Runs archiveChannel
 * 4. Verifies JSON output has correct structure (metadata field)
 * 5. Verifies SQLite DB has correct data
 * 6. Cleans up test messages and generated files
 *
 * Usage:
 *   node tests/manual/archive-e2e.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const archive = require('../../lib/archive');

// Hardcoded test parameters — use same guild as event-reminder-e2e
const GUILD_ID = '796874048281247825';
const CHANNEL_ID = '1078444159741997096';

const EMBED_WAIT_MS = 5000;  // Wait for Discord to process embeds

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`   PASS: ${label}`);
        passed++;
    } else {
        console.log(`   FAIL: ${label}`);
        failed++;
    }
}

async function runTest() {
    console.log('=== Archive E2E Test ===\n');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions
        ]
    });

    const testMessages = [];

    try {
        // Step 1: Login
        console.log('1. Logging in to Discord...');
        await client.login(process.env.DISCORD_TOKEN);
        console.log(`   Logged in as ${client.user.tag}`);

        const guild = await client.guilds.fetch(GUILD_ID);
        const channel = await client.channels.fetch(CHANNEL_ID);
        console.log(`   Guild: ${guild.name}`);
        console.log(`   Channel: #${channel.name}`);

        // Step 2: Post test messages
        console.log('\n2. Posting test messages...');

        // 2a: Plain text
        const textMsg = await channel.send('[E2E Test] Plain text message');
        testMessages.push(textMsg);
        console.log(`   Sent text message: ${textMsg.id}`);

        // 2b: URL that Discord auto-embeds
        const embedMsg = await channel.send('[E2E Test] https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        testMessages.push(embedMsg);
        console.log(`   Sent embed message: ${embedMsg.id}`);

        // 2c: Reply to first message
        const replyMsg = await channel.send({
            content: '[E2E Test] This is a reply',
            reply: { messageReference: textMsg.id }
        });
        testMessages.push(replyMsg);
        console.log(`   Sent reply message: ${replyMsg.id}`);

        // 2d: React to the text message
        await textMsg.react('👍');
        await textMsg.react('❤️');
        console.log(`   Added reactions to text message`);

        // Wait for Discord to process embeds
        console.log(`\n3. Waiting ${EMBED_WAIT_MS / 1000}s for Discord to process embeds...`);
        await new Promise(resolve => setTimeout(resolve, EMBED_WAIT_MS));

        // Step 4: Run archive
        console.log('\n4. Running archiveChannel...');
        await archive.initializeDatabaseIfNeeded(GUILD_ID);
        const archivePath = await archive.archiveChannel(channel, {
            saveMessages: true,
            saveAttachments: false
        });

        assert(archivePath !== null, 'archiveChannel returned a path');
        console.log(`   Archive path: ${archivePath}`);

        // Step 5: Verify JSON output
        console.log('\n5. Verifying JSON output...');
        const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));

        // Find our test messages in the archive
        const archivedText = archiveData.find(m => m.id === textMsg.id);
        const archivedEmbed = archiveData.find(m => m.id === embedMsg.id);
        const archivedReply = archiveData.find(m => m.id === replyMsg.id);

        assert(archivedText !== undefined, 'Text message found in archive');
        assert(archivedEmbed !== undefined, 'Embed message found in archive');
        assert(archivedReply !== undefined, 'Reply message found in archive');

        // Verify core fields
        if (archivedText) {
            assert(archivedText.id === textMsg.id, 'Text message has correct id');
            assert(typeof archivedText.createdTimestamp === 'number', 'Text message has numeric createdTimestamp');
            assert(archivedText.content.includes('[E2E Test] Plain text'), 'Text message has correct content');
        }

        // Verify reactions on text message
        if (archivedText && archivedText.metadata && archivedText.metadata.reactions) {
            const reactions = archivedText.metadata.reactions;
            assert(reactions.length >= 2, `Text message has ${reactions.length} reactions (expected >= 2)`);

            const thumbsUp = reactions.find(r => r.emoji.name === '👍');
            assert(thumbsUp !== undefined, 'Found 👍 reaction');
            if (thumbsUp) {
                assert(typeof thumbsUp.emoji === 'object', 'Reaction emoji is an object (not a string)');
                assert(thumbsUp.emoji.name === '👍', 'Emoji has name field');
                assert(thumbsUp.count >= 1, 'Emoji has count');
                assert(Array.isArray(thumbsUp.users), 'Emoji has users array');
            }
        } else {
            assert(false, 'Text message has metadata.reactions');
        }

        // Verify reply reference
        if (archivedReply && archivedReply.metadata && archivedReply.metadata.reference) {
            assert(archivedReply.metadata.reference.messageId === textMsg.id,
                'Reply references original message ID');
        } else {
            assert(false, 'Reply message has metadata.reference');
        }

        // Verify embed (Discord may not always generate embeds quickly)
        if (archivedEmbed && archivedEmbed.metadata && archivedEmbed.metadata.embeds) {
            assert(archivedEmbed.metadata.embeds.length > 0, 'Embed message has embeds in metadata');
        } else {
            console.log('   NOTE: Embed message may not have embeds (Discord processing delay)');
        }

        // Verify reply message type
        if (archivedReply && archivedReply.metadata) {
            assert(archivedReply.metadata.type === 19, 'Reply message has type 19 (REPLY)');
        }

        // Step 6: Verify SQLite DB
        console.log('\n6. Verifying SQLite database...');
        const dbPath = path.join(__dirname, '..', '..', 'Output', GUILD_ID, 'archive.db');
        const db = await open({ filename: dbPath, driver: sqlite3.Database });

        // Check that test messages exist in DB
        const dbText = await db.get('SELECT * FROM raw_archive WHERE id = ?', textMsg.id);
        const dbReply = await db.get('SELECT * FROM raw_archive WHERE id = ?', replyMsg.id);

        assert(dbText !== undefined, 'Text message found in database');
        assert(dbReply !== undefined, 'Reply message found in database');

        if (dbText) {
            assert(dbText.author_id === client.user.id, 'DB author_id matches bot user');
            assert(dbText.guild_id === GUILD_ID, 'DB guild_id is correct');
            assert(dbText.channel_id === CHANNEL_ID, 'DB channel_id is correct');
            assert(dbText.channel_name === channel.name, 'DB channel_name is correct');

            // Verify metadata column
            if (dbText.metadata) {
                const metadata = JSON.parse(dbText.metadata);
                assert(typeof metadata === 'object', 'DB metadata is valid JSON object');
                assert(Array.isArray(metadata.reactions), 'DB metadata has reactions array');
            } else {
                assert(false, 'DB text message has metadata');
            }
        }

        if (dbReply && dbReply.metadata) {
            const metadata = JSON.parse(dbReply.metadata);
            assert(metadata.reference && metadata.reference.messageId === textMsg.id,
                'DB reply metadata has correct reference');
        }

        // Check schema - should have metadata column, not mentions column
        const columns = await db.all('PRAGMA table_info(raw_archive)');
        const columnNames = columns.map(c => c.name);
        assert(columnNames.includes('metadata'), 'DB schema has metadata column');
        assert(!columnNames.includes('mentions'), 'DB schema does NOT have old mentions column');

        await db.close();

        // Step 7: Cleanup
        console.log('\n7. Cleaning up...');
        for (const msg of testMessages) {
            try {
                await msg.delete();
                console.log(`   Deleted message: ${msg.id}`);
            } catch (err) {
                console.log(`   Could not delete message ${msg.id}: ${err.message}`);
            }
        }

        // Remove generated archive files
        if (archivePath) {
            const authorsPath = archivePath.replace('archive_', 'authors_');
            try {
                fs.unlinkSync(archivePath);
                fs.unlinkSync(authorsPath);
                console.log('   Removed generated JSON files');
            } catch (err) {
                console.log(`   Could not remove files: ${err.message}`);
            }
        }

    } catch (error) {
        console.error('\nERROR:', error);
        failed++;

        // Still try to clean up messages on error
        for (const msg of testMessages) {
            try { await msg.delete(); } catch (e) { /* ignore */ }
        }
    } finally {
        console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
        client.destroy();
        process.exit(failed > 0 ? 1 : 0);
    }
}

runTest();
