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
        return 0;
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    // Skip header
    let lastTime = 0;
    for (let i = 1; i < lines.length; i++) {
        const [task, gId, cId, timestamp] = lines[i].split(',');
        
        // Only look at entries for this specific channel
        if (gId === guildId && cId === channelId) {
            console.log(`Found matching entry for channel ${channelId}: ${task} at ${new Date(parseInt(timestamp))}`);
            const time = parseInt(timestamp);
            if (time > lastTime) {
                lastTime = time;
            }
        }
    }

    // If lastTime is in the future, it's invalid
    const now = Date.now();
    if (lastTime > now) {
        console.log(`Found future timestamp ${new Date(lastTime)}, resetting to 0`);
        lastTime = 0;
    }

    console.log(`Last archive time for channel ${channelId}: ${new Date(lastTime)}`);
    return lastTime;
}

async function updateReactionData(messages) {
    console.log('Updating reaction data for messages...');
    const messageMap = new Map();

    // Batch fetch messages in groups of 100
    for (let i = 0; i < messages.length; i += 100) {
        const batch = messages.slice(i, i + 100);
        try {
            const fetchedMessages = await batch[0].channel.messages.fetch({ 
                messages: batch.map(m => m.id)
            });
            fetchedMessages.forEach(msg => messageMap.set(msg.id, msg));
        } catch (error) {
            console.error(`Error fetching message batch ${i}-${i + 100}:`, error);
        }
        await delay(1000); // Rate limit protection
    }

    // Update reaction data for each message
    for (const message of messages) {
        const fetchedMessage = messageMap.get(message.id);
        if (fetchedMessage && fetchedMessage.reactions.cache.size > 0) {
            const reactions = [];
            for (const reaction of fetchedMessage.reactions.cache.values()) {
                try {
                    const users = await reaction.users.fetch();
                    reactions.push({
                        emoji: reaction.emoji.name,
                        count: reaction.count,
                        users: users.map(user => user.id)
                    });
                } catch (error) {
                    console.error(`Error fetching users for reaction on message ${message.id}:`, error);
                }
            }
            message.reactions = reactions;
            console.log(`Reactions added for message ID: ${message.id}`);
        }
    }
}

async function analyzeArchiveSchema(channelPath) {
    console.log(`Analyzing schema for channel: ${channelPath}`);
    let allFields = new Set();
    
    const files = fs.readdirSync(channelPath);
    const archiveFiles = files.filter(f => f.startsWith('archive_'));
    const authorsFiles = files.filter(f => f.startsWith('authors_'));

    for (const archiveFile of archiveFiles) {
        const timestamp = archiveFile.split('_')[1].split('.')[0];
        const authorsFile = `authors_${timestamp}.json`;

        if (!authorsFiles.includes(authorsFile)) continue;

        console.log(`Analyzing ${archiveFile}`);
        const archiveData = JSON.parse(fs.readFileSync(path.join(channelPath, archiveFile)));
        const authorsData = JSON.parse(fs.readFileSync(path.join(channelPath, authorsFile)));

        // Analyze one merged message to get all possible fields
        const sampleMsg = archiveData[0];
        if (sampleMsg) {
            const author = Object.values(authorsData).find(a => 
                a.msgIds.includes(sampleMsg.id)
            );

            const mergedMsg = {
                ...sampleMsg,
                author_id: author?.id,
                author_username: author?.username,
                author_globalName: author?.globalName,
                guild_id: path.basename(path.dirname(channelPath)),
                channel_name: path.basename(channelPath).split('_')[0],
                channel_id: path.basename(channelPath).split('_')[1],
                archive_file: archiveFile
            };

            // Collect all fields recursively
            function addFields(obj, prefix = '') {
                if (!obj) return;
                Object.entries(obj).forEach(([key, value]) => {
                    const fieldName = prefix ? `${prefix}_${key}` : key;
                    if (typeof value === 'object' && value !== null) {
                        addFields(value, fieldName);
                    } else {
                        allFields.add(fieldName);
                    }
                });
            }

            addFields(mergedMsg);
        }
    }

    const fields = Array.from(allFields);
    console.log('Found fields:', fields);
    return fields;
}

async function initializeDatabaseIfNeeded(guildId) {
    const dbPath = path.join(__dirname, 'Output', guildId, 'archive.db');
    
    // If database exists, we're done
    if (fs.existsSync(dbPath)) {
        console.log('Database already exists');
        return;
    }

    console.log('Creating new database with schema...');
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS raw_archive (
            id TEXT PRIMARY KEY,
            createdTimestamp INTEGER,
            content TEXT,
            author_id TEXT,
            guild_id TEXT,
            channel_id TEXT,
            channel_name TEXT,
            archive_file TEXT,
            mentions TEXT,      -- JSON object of mentions
            reference TEXT,     -- JSON object of message reference
            reactions TEXT,     -- JSON array of reaction objects
            embeds TEXT,        -- JSON object of embeds
            data TEXT,          -- JSON field for any additional properties
            UNIQUE(id, guild_id)
        );
    `;

    console.log('Creating table with SQL:', createTableSQL);
    await db.exec(createTableSQL);
    await db.close();

    console.log('Database initialized successfully');
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
    if (options.saveAttachments) {
        ensureDirectoryExists(attachmentsFolderPath);
    }

    // Get all messages since last archive
    const allMessages = await fetchMessageBatch(channel, lastArchiveTime);
    if (allMessages.length === 0) {
        console.log(`No new messages to archive in channel: ${channel.name}`);
        return null;
    }

    console.log(`Found ${allMessages.length} new messages to archive`);

    // Handle attachments if enabled
    if (options.saveAttachments) {
        console.log('Downloading attachments...');
        for (const message of allMessages) {
            if (message.attachments.size > 0) {
                for (const [id, attachment] of message.attachments) {
                    const attachmentPath = path.join(attachmentsFolderPath, attachment.name);
                    try {
                        await downloadFile(attachment.url, attachmentPath);
                        console.log(`Downloaded attachment: ${attachment.name}`);
                    } catch (error) {
                        console.error(`Failed to download attachment ${attachment.name}:`, error);
                    }
                    await delay(1000); // Rate limit protection
                }
            }
        }
    }

    // Update reactions
    console.log('Updating reaction data...');
    await updateReactionData(allMessages);

    // Save to files
    console.log(`Saving ${allMessages.length} messages to archive`);
    const archivePath = path.join(baseFolderPath, `archive_${timestamp}.json`);
    const authorsPath = path.join(baseFolderPath, `authors_${timestamp}.json`);

    const scrubbedMessages = scrubMessages(allMessages);
    const authorsMap = createAuthorsMap(allMessages);
    
    saveJsonFile(archivePath, scrubbedMessages);
    saveJsonFile(authorsPath, authorsMap);

    // Log the archive step
    const logPath = path.join(__dirname, 'Output', 'log.csv');
    if (!fs.existsSync(logPath)) {
        ensureDirectoryExists(path.dirname(logPath));
        fs.writeFileSync(logPath, 'Task,GuildId,ChannelID,Timestamp\n');
    }
    fs.appendFileSync(logPath, `archive,${channel.guild.id},${channel.id},${timestamp}\n`);

    // Insert into database
    console.log('Inserting new archive into database...');
    const db = await open({
        filename: path.join(__dirname, 'Output', channel.guild.id, 'archive.db'),
        driver: sqlite3.Database
    });
    await processNewArchiveFiles(db, channel.guild.id, baseFolderPath);
    await db.close();

    console.log(`Archived ${allMessages.length} new messages from channel: ${channel.name}`);
    return archivePath;
}

async function fetchMessageBatch(channel, lastArchiveTime) {
    console.log(`Fetching messages after ${new Date(lastArchiveTime)}`);
    const allMessages = [];
    let lastId = null;
    let keepFetching = true;

    while (keepFetching) {
        const options = { limit: 100 };
        if (lastId) {
            options.before = lastId;
        }

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) {
            break;
        }

        for (const message of messages.values()) {
            // Convert both timestamps to milliseconds for comparison
            if (message.createdTimestamp > lastArchiveTime) {
                allMessages.push(message);
                console.log(`Found message: ${message.id} from ${new Date(message.createdTimestamp)}`);
            } else {
                keepFetching = false;
                break;
            }
        }

        lastId = messages.last()?.id;
        await delay(1000); // Rate limit protection
    }

    console.log(`Fetched ${allMessages.length} messages`);
    return allMessages;
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
    return messages.map(msg => {
        // Get basic message data
        const scrubbed = {
            id: msg.id,
            createdTimestamp: msg.createdTimestamp,
            content: msg.content
        };

        // Clean reactions format
        if (msg.reactions && Array.isArray(msg.reactions)) {
            scrubbed.reactions = msg.reactions.map(reaction => ({
                emoji: reaction.emoji,
                count: reaction.count,
                users: reaction.users
            }));
        }

        // Clean reference format for replies
        if (msg.reference) {
            scrubbed.reference = {
                messageId: msg.reference.messageId,
                channelId: msg.reference.channelId,
                guildId: msg.reference.guildId
            };
        }

        return scrubbed;
    });
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

async function processNewArchiveFiles(db, guildId, channelPath) {
    try {
        // Get list of processed files from log
        const logPath = path.join(__dirname, 'Output', 'log.csv');
        const processedTimestamps = new Set();
        if (fs.existsSync(logPath)) {
            const logContent = fs.readFileSync(logPath, 'utf-8');
            const lines = logContent.split('\n').filter(line => line.trim());
            
            // Skip header
            for (let i = 1; i < lines.length; i++) {
                const [task, gId, cId, timestamp] = lines[i].split(',');
                if (task.toLowerCase() === 'databaseinsertion' && 
                    gId === guildId && 
                    cId === path.basename(channelPath).split('_')[1]) {
                    processedTimestamps.add(parseInt(timestamp));
                }
            }
        }

        // Get list of unprocessed archive files
        const files = fs.readdirSync(channelPath)
            .filter(file => file.startsWith('archive_'))
            .map(file => {
                const timestamp = parseInt(file.replace('archive_', '').replace('.json', ''));
                return {
                    archiveFile: file,
                    authorsFile: file.replace('archive_', 'authors_'),
                    timestamp: timestamp
                };
            })
            .filter(file => {
                // Check if this file's timestamp is newer than any processed timestamp
                const isProcessed = Array.from(processedTimestamps).some(
                    processedTime => Math.abs(file.timestamp - processedTime) < 10000 // Within 10 seconds
                );
                if (isProcessed) {
                    console.log(`Skipping already processed file: ${file.archiveFile}`);
                    return false;
                }
                return true;
            });

        if (files.length === 0) {
            console.log('No new archive files to process');
            return;
        }

        console.log(`Found ${files.length} new archive files to process`);
        await db.run('BEGIN TRANSACTION');

        for (const file of files) {
            const archivePath = path.join(channelPath, file.archiveFile);
            const authorsPath = path.join(channelPath, file.authorsFile);

            if (!fs.existsSync(archivePath) || !fs.existsSync(authorsPath)) {
                console.log(`Skipping incomplete archive set: ${file.archiveFile}`);
                continue;
            }

            console.log(`Processing new archive: ${file.archiveFile} (timestamp: ${new Date(file.timestamp)})`);
            const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
            const authorsData = JSON.parse(fs.readFileSync(authorsPath, 'utf-8'));

            for (const msg of archiveData) {
                const author = Object.values(authorsData).find(a => 
                    a.msgIds.includes(msg.id)
                );

                if (author) {
                    const coreFields = {
                        id: msg.id,
                        createdTimestamp: msg.createdTimestamp,
                        content: msg.content,
                        author_id: author.id,
                        guild_id: guildId,
                        channel_id: path.basename(channelPath).split('_')[1],
                        channel_name: path.basename(channelPath).split('_')[0],
                        archive_file: file.archiveFile,
                        mentions: JSON.stringify(msg.mentions || {}),
                        reference: JSON.stringify(msg.reference || {}),
                        reactions: JSON.stringify(msg.reactions || []),
                        embeds: JSON.stringify(msg.embeds || {})
                    };

                    const extraData = {};
                    for (const [key, value] of Object.entries(msg)) {
                        if (!coreFields.hasOwnProperty(key) && 
                            !['mentions', 'reference', 'reactions', 'embeds'].includes(key)) {
                            extraData[key] = value;
                        }
                    }

                    await db.run(`
                        INSERT OR REPLACE INTO raw_archive 
                        (id, createdTimestamp, content, author_id, guild_id, 
                         channel_id, channel_name, archive_file, mentions,
                         reference, reactions, embeds, data)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        coreFields.id,
                        coreFields.createdTimestamp,
                        coreFields.content,
                        coreFields.author_id,
                        coreFields.guild_id,
                        coreFields.channel_id,
                        coreFields.channel_name,
                        coreFields.archive_file,
                        coreFields.mentions,
                        coreFields.reference,
                        coreFields.reactions,
                        coreFields.embeds,
                        JSON.stringify(extraData)
                    ]);
                }
            }
        }

        await db.run('COMMIT');
        
        const timestamp = Date.now();
        const logEntry = `DatabaseInsertion,${guildId},${path.basename(channelPath).split('_')[1]},${timestamp}\n`;
        fs.appendFileSync(logPath, logEntry);
        
        console.log(`Successfully processed ${files.length} new files`);
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Error processing files:', error);
        throw error;
    }
}

module.exports = {
    initializeDatabaseIfNeeded,
    handleArchiveChannelCommand,
    handleArchiveServerCommand,
    updateReactionData,
    processNewArchiveFiles,
    // Pure functions exported for testing
    scrubMessages,
    createAuthorsMap,
    getLastArchiveTime,
}; 