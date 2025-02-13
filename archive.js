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

async function handleArchivePicsCommand(interaction) {
    await interaction.deferReply();
    console.log(`Executing archivePics command by user ${interaction.user.tag} in channel ${interaction.channel.id}`);

    if (!interaction.channel.isTextBased()) {
        await interaction.editReply('This command only works in text channels.');
        return;
    }

    try {
        // Use archiveChannel but only save messages with attachments
        const archiveFilePath = await archiveChannel(interaction.channel, { attachmentsOnly: true });
        if (archiveFilePath) {
            await updateArchiveWithReactions(interaction.channel, archiveFilePath);
            await interaction.editReply(`Successfully archived images from: ${interaction.channel.name}`);
        } else {
            await interaction.editReply('No new images to archive.');
        }
    } catch (error) {
        console.error('Error archiving images:', error);
        await interaction.editReply('Failed to archive images.');
    }
}

async function handleArchiveMsgsCommand(interaction) {
    await interaction.deferReply();
    console.log(`Executing archiveMsgs command by user ${interaction.user.tag} in channel ${interaction.channel.id}`);

    if (!interaction.channel.isTextBased()) {
        await interaction.editReply('This command only works in text channels.');
        return;
    }

    try {
        const archiveFilePath = await archiveChannel(interaction.channel);
        if (archiveFilePath) {
            await updateArchiveWithReactions(interaction.channel, archiveFilePath);
            await interaction.editReply(`Successfully archived channel: ${interaction.channel.name}`);
        } else {
            await interaction.editReply('No new messages to archive.');
        }
    } catch (error) {
        console.error('Error archiving channel:', error);
        await interaction.editReply('Failed to archive messages.');
    }
}

async function handleArchiveServerCommand(message) {
    console.log(`Executing archiveAll command by user ${message.author.tag} in server ${message.guild.name}`);

    if (!message.guild) {
        await message.channel.send('This command must be run in a server.');
        return;
    }

    const guild = message.guild;
    const channels = guild.channels.cache.filter(channel => channel.isTextBased());

    for (const [channelId, channel] of channels) {
        try {
            console.log(`Archiving channel: ${channel.name} (${channelId})`);

            const archiveFilePath = await archiveChannel(channel);
            await updateArchiveWithReactions(channel, archiveFilePath);

            console.log(`Successfully archived channel: ${channel.name}`);
            await message.channel.send(`Archived channel: ${channel.name}`);
        } catch (error) {
            console.error(`Error archiving channel: ${channel.name}`, error);
            await message.channel.send(`Failed to archive channel: ${channel.name}. Error: ${error.message}`);
        }
    }

    await message.channel.send('Completed archiving all channels.');
}

async function handleArchiveAllCommand(interaction) {
    await interaction.deferReply();
    console.log(`Executing archiveAll command by user ${interaction.user.tag} in server ${interaction.guild.name}`);

    if (!interaction.guild) {
        await interaction.editReply('This command must be run in a server.');
        return;
    }

    const guild = interaction.guild;
    const channels = guild.channels.cache.filter(channel => channel.isTextBased());
    let processedCount = 0;

    for (const [channelId, channel] of channels) {
        try {
            console.log(`Archiving channel: ${channel.name} (${channelId})`);

            const archiveFilePath = await archiveChannel(channel);
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
    const logPath = path.join(__dirname, 'Output', guildId, 'log.csv');
    if (!fs.existsSync(logPath)) return 0;

    const logs = await readLogEntries(logPath);
    const channelLogs = logs.filter(log => log.channelId === channelId);
    return channelLogs.length ? 
        Math.max(...channelLogs.map(log => new Date(log.timestamp).getTime())) : 
        0;
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

async function archiveChannel(channel, options = {}) {
    const timestamp = Date.now();
    const lastArchiveTime = await getLastArchiveTime(channel.guild.id, channel.id);
    console.log(`Last archive time for ${channel.name}: ${new Date(lastArchiveTime)}`);

    // Setup folders
    const folderName = `${channel.name}_${channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', channel.guild.name, folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    ensureDirectoryExists(baseFolderPath);
    ensureDirectoryExists(attachmentsFolderPath);

    const archiveFileName = `archive_${timestamp}.json`;
    const authorsFileName = `authors_${timestamp}.json`;
    const archivePath = path.join(baseFolderPath, archiveFileName);
    const authorsPath = path.join(baseFolderPath, authorsFileName);

    let allMessages = [];
    let authors = loadExistingAuthors(authorsPath);
    let lastMessageId = null;
    let messageCount = 0;
    let newMessageCount = 0;

    // Fetch messages
    while (true) {
        const messages = await fetchMessageBatch(channel, lastMessageId, lastArchiveTime);
        if (!messages || messages.length === 0) break;

        // Filter messages based on options
        const filteredMessages = options.attachmentsOnly ? 
            messages.filter(msg => msg.attachments.size > 0) : 
            messages;

        allMessages = allMessages.concat(filteredMessages);
        lastMessageId = messages[messages.length - 1].id;
        newMessageCount = allMessages.length;

        // Process authors and attachments
        await processMessagesMetadata(messages, authors, attachmentsFolderPath);

        messageCount += messages.length;
        logProgress(channel.name, messageCount, newMessageCount);
    }

    if (allMessages.length === 0) {
        console.log(`No new messages to archive in channel: ${channel.name}`);
        return null;
    }

    // Save archive files
    const scrubbedMessages = scrubMessages(allMessages);
    saveArchiveFiles(archivePath, authorsPath, scrubbedMessages, authors);

    // Update log
    await updateArchiveLog(channel, timestamp);

    console.log(`Archived ${allMessages.length} new messages from channel: ${channel.name}`);
    return archivePath;
}

// Helper functions to keep the code DRY
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function loadExistingAuthors(authorsPath) {
    return loadJsonFile(authorsPath);
}

async function fetchMessageBatch(channel, lastMessageId, lastArchiveTime) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    try {
        const fetchedMessages = await channel.messages.fetch(options);
        if (fetchedMessages.size === 0) return null;

        const messages = Array.from(fetchedMessages.values());
        const oldestMessageTime = messages[messages.length - 1].createdTimestamp;

        if (oldestMessageTime <= lastArchiveTime) {
            return messages.filter(msg => msg.createdTimestamp > lastArchiveTime);
        }

        return messages;
    } catch (error) {
        console.error(`Error fetching messages:`, error);
        await delay(5000);
        return null;
    }
}

async function processMessagesMetadata(messages, authors, attachmentsFolderPath) {
    for (const msg of messages) {
        // Update authors
        updateAuthorData(msg, authors);
        // Download attachments
        if (msg.attachments.size > 0) {
            await downloadMessageAttachments(msg, attachmentsFolderPath);
        }
    }
}

function updateAuthorData(msg, authors) {
    const authorId = msg.author.id;
    const authorData = {
        id: authorId,
        username: msg.author.username,
        globalName: msg.author.globalName || null,
    };

    if (!authors[authorId]) {
        authors[authorId] = { ...authorData, msgIds: [msg.id] };
    } else if (!authors[authorId].msgIds.includes(msg.id)) {
        authors[authorId].msgIds.push(msg.id);
    }
}

async function downloadMessageAttachments(msg, attachmentsFolderPath) {
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

function logProgress(channelName, messageCount, newMessageCount) {
    if (messageCount % 50 === 0) {
        console.log(`[${channelName}] ${messageCount} messages processed, ${newMessageCount} new messages found.`);
    }
}

function scrubMessages(messages) {
    return messages.map(msg => {
        const cleanedMessage = scrubEmptyFields(msg);
        delete cleanedMessage.author;
        return cleanedMessage;
    });
}

function saveArchiveFiles(archivePath, authorsPath, messages, authors) {
    saveJsonFile(archivePath, messages);
    saveJsonFile(authorsPath, authors);
}

async function updateArchiveLog(channel, timestamp) {
    const logPath = path.join(__dirname, 'Output', channel.guild.name, 'log.csv');
    await appendLogEntry(logPath, {
        Task: 'archive',
        'Guild Name': channel.guild.name,
        'Channel ID': channel.id,
        'Timestamp': timestamp
    });
}

// Function to download an attachment
async function downloadAttachment(url, filePath) {
    try {
        const response = await axios({ method: 'get', url: url, responseType: 'stream' });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download ${url}:`, error);
        throw error;
    }
}

// Mock function to fetch a message from Discord
async function fetchMessageFromDiscord(channelId, messageId) {
    const channel = await client.channels.fetch(channelId); // Fetch the channel
    return channel.messages.fetch(messageId); // Fetch the message
}

module.exports = {
    handleArchivePicsCommand,
    handleArchiveMsgsCommand,
    handleArchiveServerCommand,
    handleArchiveAllCommand,
    updateReactionData,
}; 