/**
 * Discord Channel Archive System
 * 
 * Core Functions:
 * - archiveChannel: Main function for fetching and storing messages
 * - updateArchiveWithReactions: Adds reaction data to archived messages
 * - handleArchive[X]Command: Command handlers that use the core functions
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const csvWriter = require('csv-writer').createObjectCsvWriter;
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { 
    ensureDirectoryExists, 
    loadJsonFile, 
    saveJsonFile, 
    downloadFile, 
    scrubEmptyFields, 
    delay, 
    logProgress 
} = require('./helper');

async function handleArchiveChannelCommand(interaction, contentOption) {
    await interaction.deferReply();
    console.log(`Executing archive channel command by user ${interaction.user.tag} in channel ${interaction.channel.id}`);

    if (!interaction.channel.isTextBased()) {
        await interaction.editReply('This command only works in text channels.');
        return;
    }

    try {
        const options = {
            saveMessages: contentOption === 'messages' || contentOption === 'both',
            saveAttachments: contentOption === 'attachments' || contentOption === 'both'
        };

        const archiveFilePath = await archiveChannel(interaction.channel, options);
        if (archiveFilePath) {
            await updateArchiveWithReactions(interaction.channel, archiveFilePath);
            await interaction.editReply(`Successfully archived channel: ${interaction.channel.name}`);
        } else {
            await interaction.editReply('No new content to archive.');
        }
    } catch (error) {
        console.error('Error archiving channel:', error);
        await interaction.editReply('Failed to archive channel.');
    }
}

async function handleArchiveServerCommand(interaction, contentOption) {
    await interaction.deferReply();
    console.log(`Executing archive server command by user ${interaction.user.tag} in server ${interaction.guild.name}`);

    if (!interaction.guild) {
        await interaction.editReply('This command must be run in a server.');
        return;
    }

    const options = {
        saveMessages: contentOption === 'messages' || contentOption === 'both',
        saveAttachments: contentOption === 'attachments' || contentOption === 'both'
    };

    const guild = interaction.guild;
    const channels = guild.channels.cache.filter(channel => channel.isTextBased());
    let processedCount = 0;

    for (const [channelId, channel] of channels) {
        try {
            console.log(`Archiving channel: ${channel.name} (${channelId})`);

            const archiveFilePath = await archiveChannel(channel, options);
            if (archiveFilePath) {
                await updateArchiveWithReactions(channel, archiveFilePath);
            }
            
            processedCount++;
            if (processedCount % 5 === 0) {
                await interaction.editReply(`Progress: ${processedCount}/${channels.size} channels archived...`);
            }

            console.log(`Successfully archived channel: ${channel.name}`);
        } catch (error) {
            console.error(`Error archiving channel: ${channel.name}`, error);
            await interaction.followUp({
                content: `Failed to archive channel: ${channel.name}. Error: ${error.message}`,
                ephemeral: true
            });
        }
    }

    await interaction.editReply(`Completed archiving all channels (${processedCount}/${channels.size}).`);
}

async function getLastArchiveTime(guildId, channelId) {
    const logPath = path.join(__dirname, 'Output', 'log.csv');
    if (!fs.existsSync(logPath)) {
        console.log('No log file found, starting from 0');
        return 0;
    }

    try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        // Skip header
        if (lines.length <= 1) {
            console.log('No log entries found, starting from 0');
            return 0;
        }

        // Find the last archive entry for this channel and guild
        for (let i = lines.length - 1; i > 0; i--) {
            const [task, gId, channelID, timestamp] = lines[i].split(',');
            console.log(`Checking entry: task=${task}, guildId=${gId}, channel=${channelID}, looking for guildId=${guildId} channelId=${channelId}`);
            if (gId === guildId && channelID === channelId) {
                const time = parseInt(timestamp);
                console.log(`Found last archive time: ${new Date(time)}`);
                return time;
            }
        }
        console.log('No previous archive found for this channel');
        return 0;
    } catch (error) {
        console.error('Error reading log file:', error);
        return 0;
    }
}

async function updateReactionData() {
    const outputDir = path.join(__dirname, 'Output');
    const logFilePath = path.join(outputDir, 'log.csv');

    if (!fs.existsSync(logFilePath)) {
        console.error(`Log file not found: ${logFilePath}`);
        return;
    }

    // Read and parse the log file
    const logEntries = fs.readFileSync(logFilePath, 'utf-8').split('\n').slice(1); // Skip header
    const processedReactions = new Set(
        logEntries
            .map(line => line.split(','))
            .filter(entry => entry.length === 4 && entry[0] === 'reaction') // Filter for "reaction" tasks
            .map(([_, guildName, channelId, timestamp]) => `${guildName}_${channelId}_${timestamp}`)
    );

    const taskEntries = logEntries
        .map(line => line.split(','))
        .filter(entry => entry.length === 4 && entry[0] === 'archive'); // Filter for "archive" tasks

    const newLogEntries = [];

    for (const [task, guildName, channelId, timestamp] of taskEntries) {
        // Skip processing if a "reaction" task already exists for this archive
        const taskKey = `${guildName}_${channelId}_${timestamp}`;
        if (processedReactions.has(taskKey)) {
            console.log(`Skipping reactions for already processed archive: ${taskKey}`);
            continue;
        }

        // Find the channel directory based on channel ID
        const guildPath = path.join(outputDir, guildName);
        const channelDirs = fs.readdirSync(guildPath, { withFileTypes: true }).filter(dir => dir.isDirectory());
        const channelDirName = channelDirs.find(dir => dir.name.endsWith(`_${channelId}`))?.name;

        if (!channelDirName) {
            console.error(`Channel directory not found for ID: ${channelId}`);
            continue;
        }

        const archiveFilePath = path.join(guildPath, channelDirName, `archive_${timestamp}.json`);

        if (!fs.existsSync(archiveFilePath)) {
            console.error(`Archive file not found: ${archiveFilePath}`);
            continue;
        }

        console.log(`Processing reactions for archive file: ${archiveFilePath}`);

        const archiveData = JSON.parse(fs.readFileSync(archiveFilePath, 'utf-8'));
        const updatedMessages = [];

        for (const message of archiveData) {
            const messageId = message.id;

            try {
                const fetchedMessage = await fetchMessageFromDiscord(channelId, messageId); // Assuming fetchMessageFromDiscord is implemented
                const reactions = [];

                if (fetchedMessage.reactions.cache.size > 0) {
                    for (const reaction of fetchedMessage.reactions.cache.values()) {
                        const users = await reaction.users.fetch(); // Fetch users who reacted
                        const reactionData = {
                            emoji: reaction.emoji.name,
                            count: reaction.count,
                            users: users.map(user => user.id), // List of user IDs
                        };

                        reactions.push(reactionData);
                    }
                }

                // Update the message with reaction data
                message.reactions = reactions;
                console.log(`Reactions added for message ID: ${messageId}`);
            } catch (error) {
                console.error(`Error fetching reactions for message ID: ${messageId}`, error);
            }

            updatedMessages.push(message);
        }

        // Overwrite the archive file with updated messages
        fs.writeFileSync(archiveFilePath, JSON.stringify(updatedMessages, null, 2));
        console.log(`Updated reactions saved to: ${archiveFilePath}`);

        // Add a new log entry for the "reaction" task
        newLogEntries.push({
            task: 'reaction',
            guildName,
            channelId,
            timestamp,
        });
    }

    // Append new log entries to log.csv
    if (newLogEntries.length > 0) {
        const csvWriterInstance = csvWriter({
            path: logFilePath,
            append: true,
            header: [
                { id: 'task', title: 'Task' },
                { id: 'guildName', title: 'Guild Name' },
                { id: 'channelId', title: 'Channel ID' },
                { id: 'timestamp', title: 'Timestamp' },
            ],
        });

        await csvWriterInstance.writeRecords(newLogEntries);
        console.log(`Log updated with ${newLogEntries.length} "reaction" entries.`);
    } else {
        console.log('No new "reaction" entries to log.');
    }

    console.log('All archives processed for reaction data.');
}

async function archiveChannel(channel, options = { saveMessages: true, saveAttachments: true }) {
    const timestamp = Date.now();
    const lastArchiveTime = await getLastArchiveTime(channel.guild.id, channel.id);
    console.log(`Last archive time for ${channel.name}: ${new Date(lastArchiveTime)}`);

    // Setup folders
    const folderName = `${channel.name}_${channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', channel.guild.id, folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    ensureDirectoryExists(baseFolderPath);
    ensureDirectoryExists(attachmentsFolderPath);

    const archiveFileName = `archive_${timestamp}.json`;
    const authorsFileName = `authors_${timestamp}.json`;
    const archivePath = path.join(baseFolderPath, archiveFileName);
    const authorsPath = path.join(baseFolderPath, authorsFileName);

    let allMessages = [];
    let lastMessageId = null;
    let messageCount = 0;

    while (true) {
        const messages = await fetchMessageBatch(channel, lastMessageId, lastArchiveTime);
        console.log(`Batch received: ${messages.length} messages`);
        if (messages.length === 0) break;

        // Changed filtering logic to be more permissive
        const filteredMessages = messages;  // Remove filtering since options are both true by default
        console.log(`Filtered messages count: ${filteredMessages.length}`);
        
        allMessages = allMessages.concat(filteredMessages);
        lastMessageId = messages[messages.length - 1].id;
        messageCount += messages.length;
        
        if (options.saveAttachments) {
            await processMessagesMetadata(messages, attachmentsFolderPath);
        }
        logProgress(channel.name, messageCount, allMessages.length);
    }

    console.log(`Total accumulated messages: ${allMessages.length}`);
    
    if (allMessages.length === 0) {
        console.log(`No new messages to archive in channel: ${channel.name}`);
        return null;
    }

    console.log(`Saving ${allMessages.length} messages to ${archivePath}`);

    // Save messages and authors files
    const scrubbedMessages = scrubMessages(allMessages);
    const authorsMap = createAuthorsMap(allMessages);
    
    saveJsonFile(archivePath, scrubbedMessages);
    saveJsonFile(authorsPath, authorsMap);

    const db = await initializeDatabase(channel.guild.id);
    await insertArchiveData(db, scrubbedMessages, channel);
    await db.close();

    await updateArchiveLog(channel, timestamp);

    console.log(`Archived ${allMessages.length} new messages from channel: ${channel.name}`);
    return archivePath;
}

async function fetchMessageBatch(channel, lastMessageId, lastArchiveTime) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    try {
        const fetchedMessages = await channel.messages.fetch(options);
        console.log(`Fetched ${fetchedMessages.size} messages`);
        
        if (fetchedMessages.size === 0) return [];

        const messages = Array.from(fetchedMessages.values());
        const oldestMessage = messages[messages.length - 1];
        const newestMessage = messages[0];
        
        console.log(`Message range: ${new Date(newestMessage.createdTimestamp)} to ${new Date(oldestMessage.createdTimestamp)}`);
        console.log(`Last archive time: ${new Date(lastArchiveTime)}`);

        if (lastArchiveTime > 0) {
            const newMessages = messages.filter(msg => {
                const isNewer = msg.createdTimestamp > lastArchiveTime;
                if (isNewer) {
                    console.log(`Found newer message: ${msg.id} from ${new Date(msg.createdTimestamp)}`);
                }
                return isNewer;
            });
            console.log(`Found ${newMessages.length} messages newer than last archive`);
            // Always return an array, even if empty
            return newMessages;  
        }

        return messages;
    } catch (error) {
        console.error(`Error fetching messages:`, error);
        await delay(5000);
        return [];
    }
}

async function processMessagesMetadata(messages, attachmentsFolderPath) {
    for (const msg of messages) {
        if (msg.attachments.size > 0) {
            for (const attachment of msg.attachments.values()) {
                const url = attachment.url;
                const fileName = path.basename(new URL(url).pathname);
                const filePath = path.join(attachmentsFolderPath, fileName);

                try {
                    await downloadFile(url, filePath);
                } catch (error) {
                    console.error(`Error downloading attachment for message ID: ${msg.id}`, error);
                }
            }
        }
    }
}

function scrubMessages(messages) {
    return messages.map(msg => ({
        id: msg.id,
        createdTimestamp: msg.createdTimestamp,
        content: msg.content,
        nonce: msg.nonce || undefined
    }));
}

function createAuthorsMap(messages) {
    const authorsMap = {};
    
    messages.forEach(msg => {
        if (!authorsMap[msg.author.id]) {
            authorsMap[msg.author.id] = {
                id: msg.author.id,
                username: msg.author.username,
                globalName: msg.author.globalName,
                msgIds: []
            };
        }
        authorsMap[msg.author.id].msgIds.push(msg.id);
    });

    return authorsMap;
}

async function updateArchiveLog(channel, timestamp) {
    const logPath = path.join(__dirname, 'Output', 'log.csv');
    
    // Create log file with headers if it doesn't exist
    if (!fs.existsSync(logPath)) {
        ensureDirectoryExists(path.dirname(logPath));
        fs.writeFileSync(logPath, 'Task,GuildId,ChannelID,Timestamp\n');
    }

    // Add new log entry
    const logEntry = `archive,${channel.guild.id},${channel.id},${timestamp}\n`;
    fs.appendFileSync(logPath, logEntry);
    console.log(`Updated log: ${logEntry.trim()}`);
}

// Mock function to fetch a message from Discord
async function fetchMessageFromDiscord(channelId, messageId) {
    const channel = await client.channels.fetch(channelId); // Fetch the channel
    return channel.messages.fetch(messageId); // Fetch the message
}

async function analyzeArchiveSchema() {
    const outputDir = path.join(__dirname, 'Output');
    const guildDirs = fs.readdirSync(outputDir).filter(f => 
        fs.statSync(path.join(outputDir, f)).isDirectory()
    );

    const schema = new Set();
    
    for (const guildDir of guildDirs) {
        const guildPath = path.join(outputDir, guildDir);
        const channelDirs = fs.readdirSync(guildPath).filter(f => 
            fs.statSync(path.join(guildPath, f)).isDirectory() && 
            !f.includes('attachments')
        );

        for (const channelDir of channelDirs) {
            const channelPath = path.join(guildPath, channelDir);
            const archiveFiles = fs.readdirSync(channelPath).filter(f => 
                f.startsWith('archive_') && f.endsWith('.json')
            );

            for (const archiveFile of archiveFiles) {
                const messages = loadJsonFile(path.join(channelPath, archiveFile));
                for (const msg of messages) {
                    collectFields(msg, '', schema);
                }
            }
        }
    }

    return Array.from(schema);
}

function collectFields(obj, prefix, schema) {
    for (const [key, value] of Object.entries(obj)) {
        const fieldName = prefix ? `${prefix}_${key}` : key;
        
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            collectFields(value, fieldName, schema);
        } else {
            schema.add(fieldName);
        }
    }
}

async function initializeDatabase(guildId) {
    const dbPath = path.join(__dirname, 'Output', guildId, 'archive.db');
    ensureDirectoryExists(path.dirname(dbPath));

    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // Get or create schema
    const schemaPath = path.join(__dirname, 'schema.json');
    let fields;
    if (!fs.existsSync(schemaPath)) {
        fields = await analyzeArchiveSchema();
        saveJsonFile(schemaPath, fields);
    } else {
        fields = loadJsonFile(schemaPath);
    }

    // Create table if it doesn't exist
    const columns = fields.map(field => {
        if (field === 'id') return 'id TEXT PRIMARY KEY';
        if (field === 'createdTimestamp') return 'createdTimestamp INTEGER';
        return `${field.replace(/[^a-zA-Z0-9_]/g, '_')} TEXT`;
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS raw_archive (
            ${columns.join(',\n')}
        )
    `);

    return db;
}

async function insertArchiveData(db, messages, channel) {
    const fields = loadJsonFile(path.join(__dirname, 'schema.json'));
    
    for (const msg of messages) {
        const flatMsg = flattenMessage(msg, fields);
        const columns = Object.keys(flatMsg).join(', ');
        const placeholders = Object.keys(flatMsg).map(() => '?').join(', ');
        const values = Object.values(flatMsg);

        try {
            await db.run(
                `INSERT OR REPLACE INTO raw_archive (${columns}) VALUES (${placeholders})`,
                values
            );
        } catch (error) {
            console.error(`Error inserting message ${msg.id}:`, error);
        }
    }
}

function flattenMessage(msg, fields) {
    const flat = {};
    for (const field of fields) {
        const value = field.split('_').reduce((obj, key) => obj?.[key], msg);
        flat[field.replace(/[^a-zA-Z0-9_]/g, '_')] = value ?? null;
    }
    return flat;
}

async function updateArchiveWithReactions(channel, archiveFilePath) {
    // archiveFilePath is already correct as it's passed in
    // ... rest of function remains the same
}

module.exports = {
    handleArchiveChannelCommand,
    handleArchiveServerCommand,
    updateReactionData,
}; 