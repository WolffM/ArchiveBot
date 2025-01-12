const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const tasklist = require('./tasklist');
const csvWriter = require('csv-writer').createObjectCsvWriter;
const {
    readLogEntries,
    appendLogEntry,
    ensureDirectoryExists,
    getMonthYear,
    getYear, detectLinkProvider,
    // possibly other helpers...
} = require('./helper'); // or './helpers' etc.

require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const COMMAND_PREFIX = '!';

// Admin user IDs from .env
const adminUserIds = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

// Command handlers map
const adminCommands = new Map();
const standardCommands = new Map();

// Archive Pictures Command
adminCommands.set('archivePics', {
    description: 'Archives images from the channel',
    execute: handleArchivePicsCommand,
});

// Archive All Command
adminCommands.set('archiveAll', {
    description: 'Archives all messages from the channel',
    execute: handleArchiveAllCommand,
});

// Archive All Command
adminCommands.set('archiveServer', {
    description: 'Archives all messages from the server',
    execute: handleArchiveServerCommand,
});

// Archive Messages Command
adminCommands.set('archiveMsgs', {
    description: 'Archives messages (without attachments) from the channel',
    execute: handleArchiveMsgsCommand,
});

// Init Logs Command
adminCommands.set('initlogs', {
    description: 'initlogs',
    execute: updateReactionData,
});

//Make the recaps
adminCommands.set('calculateRecaps', {
    description: 'initlogs',
    execute: handleCalculateRecapsCommand,
});

// Test Command
standardCommands.set('test', {
    description: 'Logs the user ID to the console',
    execute: handleTestCommand,
});

standardCommands.set('myRecap', {
    description: 'Logs the users recap to the channel console',
    execute: handleMyRecapCommand,
});

// Client ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is online!`);
});

// Message create event
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(COMMAND_PREFIX)) return;

    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/ +/);
    const commandName = args.shift();

    // Task-related commands
    const taskCommands = ['add', 'done', 'delete', 'take', 'init', 'helpt', 'testt'];
    if (taskCommands.includes(commandName)) {
        if (commandName === 'init' && !adminUserIds.includes(message.author.id)) {
            message.channel.send("Insufficient permission, please contact an admin.");
            return;
        }
        
        try {
            await tasklist.start(message, [commandName, ...args], adminUserIds);
        } catch (error) {
            console.error(`Error executing task command ${commandName}:`, error);
            message.channel.send(`There was an error processing the command: ${commandName}`);
        }
        return;
    }

    // Check for admin commands
    if (adminCommands.has(commandName)) {
        if (!adminUserIds.includes(message.author.id)) {
            message.channel.send("Insufficient permission, please contact an admin.");
            return;
        }

        const command = adminCommands.get(commandName);
        try {
            await command.execute(message, args);
        } catch (error) {
            console.error(`Error executing admin command ${commandName}:`, error);
            message.channel.send(`There was an error executing that command.`);
        }
        return;
    }

    // Check for standard commands
    if (standardCommands.has(commandName)) {
        const command = standardCommands.get(commandName);
        try {
            await command.execute(message, args);
        } catch (error) {
            console.error(`Error executing standard command ${commandName}:`, error);
            message.channel.send(`There was an error executing that command.`);
        }
        return;
    }
});

async function initLog() {
    const outputDir = path.join(__dirname, 'Output');
    const logFilePath = path.join(outputDir, 'log.csv');

    // Create log.csv if it doesn't exist
    if (!fs.existsSync(logFilePath)) {
        console.log(`Creating log file: ${logFilePath}`);
        const csvWriterInstance = csvWriter({
            path: logFilePath,
            header: [
                { id: 'task', title: 'Task' },
                { id: 'guildName', title: 'Guild Name' },
                { id: 'channelId', title: 'Channel ID' },
                { id: 'timestamp', title: 'Timestamp' },
            ],
        });

        await csvWriterInstance.writeRecords([]); // Create an empty CSV
    }

    const logEntries = [];
    const guildDirectories = fs.readdirSync(outputDir, { withFileTypes: true }).filter(dir => dir.isDirectory());

    // Define the hardcoded list of file types to consider
    const supportedFiles = ['archive'];

    guildDirectories.forEach(guildDir => {
        const guildName = guildDir.name; // Guild name is the directory name
        const guildPath = path.join(outputDir, guildName);
        const channelDirectories = fs.readdirSync(guildPath, { withFileTypes: true }).filter(dir => dir.isDirectory());

        channelDirectories.forEach(channelDir => {
            const channelId = channelDir.name.split('_').pop(); // Extract channel ID from directory name
            const channelPath = path.join(guildPath, channelDir.name);
            const archiveFiles = fs.readdirSync(channelPath).filter(file => file.endsWith('.json'));

            archiveFiles.forEach(archiveFile => {
                const filePrefix = archiveFile.split('_')[0]; // Extract the file prefix
                if (supportedFiles.includes(filePrefix)) {
                    const timestampMatch = archiveFile.match(/_(\d+)\.json$/);
                    if (timestampMatch) {
                        const timestamp = timestampMatch[1];

                        logEntries.push({
                            task: filePrefix,
                            guildName,
                            channelId,
                            timestamp,
                        });
                    }
                }
            });
        });
    });

    if (logEntries.length > 0) {
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

        await csvWriterInstance.writeRecords(logEntries);
        console.log(`Log updated with ${logEntries.length} entries.`);
    } else {
        console.log('No archives found to log.');
    }
}

async function handleArchivePicsCommand(message, args) {
    console.log(`Executing archivePics command by user ${message.author.tag} in channel ${message.channel.id}`);

    if (!message.channel.isTextBased()) {
        message.channel.send('This command only works in text channels.');
        return;
    }

    const folderName = `${message.channel.name}_${message.channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    if (!fs.existsSync(baseFolderPath)) {
        fs.mkdirSync(baseFolderPath, { recursive: true });
    }
    if (!fs.existsSync(attachmentsFolderPath)) {
        fs.mkdirSync(attachmentsFolderPath);
    }

    let messages;
    try {
        messages = await message.channel.messages.fetch({ limit: 100 });
    } catch (error) {
        console.error('Failed to fetch messages:', error);
        message.channel.send('Could not fetch messages.');
        return;
    }

    const imageMessages = messages.filter((msg) => msg.attachments.size > 0);

    for (const [msgId, msg] of imageMessages) {
        for (const attachment of msg.attachments.values()) {
            const url = attachment.url;
            const fileName = path.basename(new URL(url).pathname);
            const filePath = path.join(attachmentsFolderPath, fileName);

            try {
                await downloadAttachment(url, filePath);
            } catch (error) {
                console.error(`Error downloading attachment ${url}:`, error);
            }
        }
    }

    message.channel.send(`Archived images to folder: ${folderName}`);
}

async function handleArchiveMsgsCommand(message, args) {
    console.log(`Executing archiveMsgs command by user ${message.author.tag} in channel ${message.channel.id}`);

    if (!message.channel.isTextBased()) {
        message.channel.send('This command only works in text channels.');
        return;
    }

    const timestamp = Date.now();
    const folderName = `${message.channel.name}_${message.channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    if (!fs.existsSync(baseFolderPath)) {
        fs.mkdirSync(baseFolderPath, { recursive: true });
    }
    if (!fs.existsSync(attachmentsFolderPath)) {
        fs.mkdirSync(attachmentsFolderPath);
    }

    const archiveFileName = `archive_${timestamp}.json`;
    const authorsFileName = `authors_${timestamp}.json`;
    const archivePath = path.join(baseFolderPath, archiveFileName);
    const authorsPath = path.join(baseFolderPath, authorsFileName);

    let allMessages = [];
    let authors = fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath)) : {};
    let lastMessageId = null;
    let messageCount = 0;

    while (true) {
        const options = { limit: 100 };
        if (lastMessageId) options.before = lastMessageId;

        const fetchedMessages = await message.channel.messages.fetch(options);
        if (fetchedMessages.size === 0) break;

        allMessages = allMessages.concat(Array.from(fetchedMessages.values()));
        lastMessageId = fetchedMessages.last().id;

        for (const [msgId, msg] of fetchedMessages) {
            const authorId = msg.author.id;
            const authorData = {
                id: authorId,
                username: msg.author.username,
                globalName: msg.author.globalName || null,
            };

            if (!authors[authorId]) {
                authors[authorId] = { ...authorData, msgIds: [msgId] };
            } else {
                if (!authors[authorId].msgIds.includes(msgId)) {
                    authors[authorId].msgIds.push(msgId);
                }
            }
        }

        messageCount += fetchedMessages.size;
        if (messageCount % 50 === 0) {
            console.log(`${messageCount} messages processed so far.`);
        }
    }

    const scrubbedMessages = allMessages.map(msg => {
        const cleanedMessage = scrubEmptyFields(msg);
        delete cleanedMessage.author; // Remove author field
        return cleanedMessage;
    });

    fs.writeFileSync(archivePath, JSON.stringify(scrubbedMessages, null, 2));
    fs.writeFileSync(authorsPath, JSON.stringify(authors, null, 2));

    message.channel.send(`Archived all messages to directory: ${archivePath}, and saved metadata to file: ${archiveFileName}`);
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

async function handleArchiveAllCommand(message, args) {
    console.log(`Executing archiveAll command by user ${message.author.tag} in channel ${message.channel.id}`);

    if (!message.channel.isTextBased()) {
        message.channel.send('This command only works in text channels.');
        return;
    }

    const timestamp = Date.now();
    const folderName = `${message.channel.name}_${message.channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    if (!fs.existsSync(baseFolderPath)) {
        fs.mkdirSync(baseFolderPath, { recursive: true });
    }
    if (!fs.existsSync(attachmentsFolderPath)) {
        fs.mkdirSync(attachmentsFolderPath);
    }

    const archiveFileName = `archive_${timestamp}.json`;
    const authorsFileName = `authors_${timestamp}.json`;
    const archivePath = path.join(baseFolderPath, archiveFileName);
    const authorsPath = path.join(baseFolderPath, authorsFileName);

    let allMessages = [];
    let authors = fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath)) : {};
    let lastMessageId = null;
    let messageCount = 0;

    while (true) {
        const options = { limit: 100 };
        if (lastMessageId) options.before = lastMessageId;

        const fetchedMessages = await message.channel.messages.fetch(options);
        if (fetchedMessages.size === 0) break;

        allMessages = allMessages.concat(Array.from(fetchedMessages.values()));
        lastMessageId = fetchedMessages.last().id;

        for (const [msgId, msg] of fetchedMessages) {
            const authorId = msg.author.id;
            const authorData = {
                id: authorId,
                username: msg.author.username,
                globalName: msg.author.globalName || null,
            };

            if (!authors[authorId]) {
                authors[authorId] = { ...authorData, msgIds: [msgId] };
            } else {
                if (!authors[authorId].msgIds.includes(msgId)) {
                    authors[authorId].msgIds.push(msgId);
                }
            }

            if (msg.attachments.size > 0) {
                for (const attachment of msg.attachments.values()) {
                    const url = attachment.url;
                    const fileName = path.basename(new URL(url).pathname);
                    const filePath = path.join(attachmentsFolderPath, fileName);

                    try {
                        await downloadAttachment(url, filePath);
                    } catch (error) {
                        console.error(`Error downloading attachment for message ID: ${msgId}, Date: ${msg.createdAt}`);
                    }
                }
            }
        }

        messageCount += fetchedMessages.size;
        if (messageCount % 50 === 0) {
            console.log(`${messageCount} messages processed so far.`);
        }
    }

    const scrubbedMessages = allMessages.map(msg => {
        const cleanedMessage = scrubEmptyFields(msg);
        delete cleanedMessage.author; // Remove author field
        return cleanedMessage;
    });

    fs.writeFileSync(archivePath, JSON.stringify(scrubbedMessages, null, 2));
    fs.writeFileSync(authorsPath, JSON.stringify(authors, null, 2));

    message.channel.send(`Archived all messages and attachments to directory: ${archivePath}, and saved metadata to file: ${archiveFileName}`);
}

async function handleCalculateRecapsCommand(message, args) {
    console.log('[handleCalculateRecapsCommand] Starting recap calculation...');

    // 1) Prep the paths
    const OUTPUT_PATH = path.join(__dirname, 'Output');
    const LOG_FILE = path.join(OUTPUT_PATH, 'log.csv');

    // 2) Read existing log.csv to find newest "calculatedMsgRec" timestamp
    console.log('[handleCalculateRecapsCommand] Reading existing log entries...');
    const allLogEntries = readLogEntries(LOG_FILE);

    let newestRecapTimestamp = 0;
    for (const record of allLogEntries) {
        if (record.Task === 'calculatedMsgRec') {
            const ts = Number(record.Timestamp);
            if (ts > newestRecapTimestamp) {
                newestRecapTimestamp = ts;
            }
        }
    }
    console.log(`[handleCalculateRecapsCommand] newestRecapTimestamp: ${newestRecapTimestamp}`);

    // 3) Data structures to accumulate info
    //    userData[guildName][userId] = { username, messages: [...], reactions: [...] }
    const userData = {};

    //    messageMap[guildName][channelId][msgId] = { content, createdTimestamp, authorId, reactCount, repliedCount, ... }
    const messageMap = {};

    //    statsByGuild[guildName] => holds final "Counts.json" info
    const statsByGuild = {};

    // Helper function to create YYYY-MM from a timestamp

    // STEP 4) Traverse the archived data to populate userData, messageMap, statsByGuild
    // If this step is missing, you'll have no data to recap.
    const guildFolders = fs.readdirSync(OUTPUT_PATH, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const guildName of guildFolders) {
        // We’ll ignore the "recaps" folder if it exists so we don’t parse our own output
        if (guildName === 'recaps') {
            continue;
        }

        console.log(`\n[handleCalculateRecapsCommand] Processing guild folder: ${guildName}`);

        if (!userData[guildName]) userData[guildName] = {};
        if (!messageMap[guildName]) messageMap[guildName] = {};
        if (!statsByGuild[guildName]) {
            statsByGuild[guildName] = {
                msgCountByUserByMonthYear: {},
                msgCountByChannelIdByMonthYear: {},
                countByReactionName: {},
                mostReactedMessageByUserId: {},
                mostRepliedMessageByUserId: {},
                linkCountByUserYear: {}
            };
        }

        const guildPath = path.join(OUTPUT_PATH, guildName);
        const channelFolders = fs.readdirSync(guildPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const channelFolder of channelFolders) {
            // Example: "general_123456789"
            const parts = channelFolder.split('_');
            const channelId = parts[parts.length - 1];

            console.log(`  [Guild: ${guildName}] Found channel folder: ${channelFolder}`);

            if (!messageMap[guildName][channelId]) {
                messageMap[guildName][channelId] = {};
            }

            const channelPath = path.join(guildPath, channelFolder);
            const archiveFiles = fs.readdirSync(channelPath)
                .filter(fn => fn.startsWith('archive_') && fn.endsWith('.json'));

            for (const fileName of archiveFiles) {
                const match = fileName.match(/^archive_(\d+)\.json$/);
                if (!match) continue;

                const archiveTimestamp = Number(match[1]);
                if (archiveTimestamp <= newestRecapTimestamp) {
                    console.log(`    [Channel: ${channelFolder}] Skipping older archive: ${fileName}`);
                    continue;
                }

                console.log(`    [Channel: ${channelFolder}] Reading messages from: ${fileName}`);
                const archivePath = path.join(channelPath, fileName);

                let messages = [];
                try {
                    messages = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
                } catch (err) {
                    console.error(`    ERROR parsing archive file: ${archivePath}`, err);
                    continue;
                }

                // authors_<timestamp>.json
                const authorsFilePath = path.join(channelPath, `authors_${archiveTimestamp}.json`);
                let authorsJson = {};
                if (fs.existsSync(authorsFilePath)) {
                    try {
                        authorsJson = JSON.parse(fs.readFileSync(authorsFilePath, 'utf8'));
                        console.log(`    Loaded authors_${archiveTimestamp}.json`);
                    } catch (err) {
                        console.error(`    ERROR parsing authors file: ${authorsFilePath}`, err);
                    }
                }

                // Populate data from each message
                messages.forEach(msg => {
                    const msgId = msg.id;

                    // 1) Identify authorId
                    let authorId = null;
                    for (const [uId, userInfo] of Object.entries(authorsJson)) {
                        if (userInfo.msgIds && userInfo.msgIds.includes(msgId)) {
                            authorId = uId;
                            break;
                        }
                    }
                    if (!authorId) return; // skip unknown authors

                    // 2) Ensure userData
                    if (!userData[guildName][authorId]) {
                        const fallbackName = authorsJson[authorId]?.username || `Unknown_${authorId}`;
                        userData[guildName][authorId] = {
                            username: fallbackName,
                            messages: [],
                            reactions: []
                        };
                    }

                    // 3) Build or update messageMap
                    const monthYear = getMonthYear(msg.createdTimestamp);
                    const year = getYear(msg.createdTimestamp);

                    let reactedCount = 0;
                    if (Array.isArray(msg.reactions)) {
                        for (const r of msg.reactions) {
                            reactedCount += r.count || 0;
                        }
                    }

                    messageMap[guildName][channelId][msgId] = {
                        id: msgId,
                        createdTimestamp: msg.createdTimestamp,
                        content: msg.content,
                        authorId,
                        channelId,
                        reactCount: reactedCount,
                        repliedCount: 0 // we’ll handle if references exist
                    };

                    // userData: add the message reference
                    userData[guildName][authorId].messages.push({
                        id: msgId,
                        createdTimestamp: msg.createdTimestamp,
                        content: msg.content
                    });

                    // 4) statsByGuild: track message counts, reactions, etc.
                    const guildStats = statsByGuild[guildName];

                    // msgCountByUserByMonthYear
                    if (!guildStats.msgCountByUserByMonthYear[monthYear]) {
                        guildStats.msgCountByUserByMonthYear[monthYear] = {};
                    }
                    if (!guildStats.msgCountByUserByMonthYear[monthYear][authorId]) {
                        guildStats.msgCountByUserByMonthYear[monthYear][authorId] = 0;
                    }
                    guildStats.msgCountByUserByMonthYear[monthYear][authorId]++;

                    // msgCountByChannelIdByMonthYear
                    if (!guildStats.msgCountByChannelIdByMonthYear[monthYear]) {
                        guildStats.msgCountByChannelIdByMonthYear[monthYear] = {};
                    }
                    if (!guildStats.msgCountByChannelIdByMonthYear[monthYear][channelId]) {
                        guildStats.msgCountByChannelIdByMonthYear[monthYear][channelId] = 0;
                    }
                    guildStats.msgCountByChannelIdByMonthYear[monthYear][channelId]++;

                    // countByReactionName
                    if (Array.isArray(msg.reactions)) {
                        msg.reactions.forEach(r => {
                            const rName = r.emoji;
                            const rCount = r.count || 0;
                            if (!guildStats.countByReactionName[monthYear]) {
                                guildStats.countByReactionName[monthYear] = {};
                            }
                            if (!guildStats.countByReactionName[monthYear][rName]) {
                                guildStats.countByReactionName[monthYear][rName] = 0;
                            }
                            guildStats.countByReactionName[monthYear][rName] += rCount;
                        });
                    }

                    // mostReactedMessageByUserId
                    if (!guildStats.mostReactedMessageByUserId[monthYear]) {
                        guildStats.mostReactedMessageByUserId[monthYear] = {};
                    }
                    const existing = guildStats.mostReactedMessageByUserId[monthYear][authorId];
                    if (!existing || reactedCount > existing.reactCount) {
                        guildStats.mostReactedMessageByUserId[monthYear][authorId] = {
                            msgId,
                            reactCount: reactedCount
                        };
                    }
                }); // end messages.forEach
            } // end for (archiveFiles)
        } // end for (channelFolders)
    } // end for (guildFolders)

    // 5) If your messages have references, you’d do a second pass for repliedCount.
    //    (Omitted here for brevity, unless your data uses .referenceMessageId or similar.)

    /**
     * 6) Finalize “mostRepliedMessageByUserId” 
     *    (Right now, this will do nothing if you didn’t populate repliedCount earlier.)
     */
    console.log('[handleCalculateRecapsCommand] Finalizing “mostRepliedMessageByUserId” stats...');
    for (const gName of Object.keys(messageMap)) {
        for (const chId of Object.keys(messageMap[gName])) {
            for (const mId of Object.keys(messageMap[gName][chId])) {
                const msgObj = messageMap[gName][chId][mId];
                const { authorId, repliedCount, createdTimestamp } = msgObj;
                if (!authorId) continue;

                const monthYear = getMonthYear(createdTimestamp);
                const stats = statsByGuild[gName];

                if (!stats.mostRepliedMessageByUserId[monthYear]) {
                    stats.mostRepliedMessageByUserId[monthYear] = {};
                }
                const existing = stats.mostRepliedMessageByUserId[monthYear][authorId];
                if (!existing || repliedCount > existing.repliedCount) {
                    stats.mostRepliedMessageByUserId[monthYear][authorId] = {
                        msgId: mId,
                        repliedCount
                    };
                }
            }
        }
    }

    /**
     * 7) Write out each user’s data to /Output/recaps/<guildName>/<username>_<userId>_Messages.json
     *    and Reactions.json, including reactedCount/repliedCount
     */
    console.log('[handleCalculateRecapsCommand] Writing user recaps...');
    const recapsRootPath = path.join(OUTPUT_PATH, 'recaps');
    ensureDirectoryExists(recapsRootPath);

    for (const [gName, usersMap] of Object.entries(userData)) {
        const guildRecapPath = path.join(recapsRootPath, gName);
        ensureDirectoryExists(guildRecapPath);

        for (const [userId, data] of Object.entries(usersMap)) {
            const safeUsername = data.username.replace(/[^a-z0-9_\-]/gi, '_');

            const finalMessages = data.messages.map(m => {
                // find which channel has this msg
                const chId = Object.keys(messageMap[gName]).find(cid => {
                    return messageMap[gName][cid][m.id];
                });
                if (!chId) {
                    return { ...m, reactedCount: 0, repliedCount: 0 };
                }
                const mm = messageMap[gName][chId][m.id];
                return {
                    ...m,
                    reactedCount: mm.reactCount,
                    repliedCount: mm.repliedCount
                };
            });

            // Write Messages.json
            const msgFilePath = path.join(guildRecapPath, `${safeUsername}_${userId}_Messages.json`);
            fs.writeFileSync(msgFilePath, JSON.stringify(finalMessages, null, 2), 'utf8');

            // Write Reactions.json
            const reactFilePath = path.join(guildRecapPath, `${safeUsername}_${userId}_Reactions.json`);
            fs.writeFileSync(reactFilePath, JSON.stringify(data.reactions, null, 2), 'utf8');
        }
    }

    /**
     * 8) Generate /Output/recaps/<guildName>/Counts.json
     *    Consolidate your stats into the final shape
     */
    console.log('[handleCalculateRecapsCommand] Generating Counts.json for each guild...');
    for (const [gName, stats] of Object.entries(statsByGuild)) {
        const outPath = path.join(recapsRootPath, gName, 'Counts.json');

        // Consolidation logic omitted for brevity, but presumably same as you had before.
        // For example:
        // msgCountByUserIdByMonthYear => consolidated array
        // msgCountByChannelIdByMonthYear => consolidated array
        // etc.

        // Example minimal version:
        const summaryData = {
            // Just showing we have some data
            rawUserMonthData: stats.msgCountByUserByMonthYear,
            rawChannelMonthData: stats.msgCountByChannelIdByMonthYear,
            rawMostReacted: stats.mostReactedMessageByUserId,
            rawMostReplied: stats.mostRepliedMessageByUserId
        };

        fs.writeFileSync(outPath, JSON.stringify(summaryData, null, 2), 'utf8');
        console.log(`  [${gName}] Wrote consolidated Counts.json => ${outPath}`);
    }

    /**
     * 9) Append ONE final log entry properly (with newline).
     *    If your appendLogEntry doesn't ensure a newline, do it manually:
     */
    const finalRecapTimestamp = Date.now();
    const newLogLine = `calculatedMsgRec,ALL_GUILDS,ALL_CHANNELS,${finalRecapTimestamp}\n`; // note the \n
    // If you have a custom helper, call that. If not, do:
    fs.appendFileSync(LOG_FILE, newLogLine, 'utf8');

    // Done
    console.log(`[handleCalculateRecapsCommand] Appended single log entry with timestamp: ${finalRecapTimestamp}`);
    message.channel.send('Recap calculation complete. Check logs and Output/recaps for results!');
    console.log('[handleCalculateRecapsCommand] Done!');
}

async function handleMyRecapCommand(message, args) {
    //TODO implement fetching personal recap message
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

// Mock function to fetch a message from Discord
async function fetchMessageFromDiscord(channelId, messageId) {
    const channel = await client.channels.fetch(channelId); // Fetch the channel
    return channel.messages.fetch(messageId); // Fetch the message
}

function handleTestCommand(message, args) {
    console.log(`User ID: ${message.author.id}`);
    message.channel.send(`User ID logged to console.`);
}

async function archiveChannel(channel) {
    const timestamp = Date.now();
    const folderName = `${channel.name}_${channel.id}`;
    const baseFolderPath = path.join(__dirname, 'Output', folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    
    if (!fs.existsSync(baseFolderPath)) {
        fs.mkdirSync(baseFolderPath, { recursive: true });
    }
    if (!fs.existsSync(attachmentsFolderPath)) {
        fs.mkdirSync(attachmentsFolderPath);
    }

    const archiveFileName = `archive_${timestamp}.json`;
    const authorsFileName = `authors_${timestamp}.json`;
    const archivePath = path.join(baseFolderPath, archiveFileName);
    const authorsPath = path.join(baseFolderPath, authorsFileName);

    let allMessages = [];
    let authors = fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath)) : {};
    let lastMessageId = null;
    let messageCount = 0;

    while (true) {
        const options = { limit: 100 };
        if (lastMessageId) options.before = lastMessageId;

        try {
            const fetchedMessages = await channel.messages.fetch(options);
            if (fetchedMessages.size === 0) break;

            allMessages = allMessages.concat(Array.from(fetchedMessages.values()));
            lastMessageId = fetchedMessages.last().id;

            for (const [msgId, msg] of fetchedMessages) {
                const authorId = msg.author.id;
                const authorData = {
                    id: authorId,
                    username: msg.author.username,
                    globalName: msg.author.globalName || null,
                };

                if (!authors[authorId]) {
                    authors[authorId] = { ...authorData, msgIds: [msgId] };
                } else {
                    if (!authors[authorId].msgIds.includes(msgId)) {
                        authors[authorId].msgIds.push(msgId);
                    }
                }

                if (msg.attachments.size > 0) {
                    for (const attachment of msg.attachments.values()) {
                        const url = attachment.url;
                        const fileName = path.basename(new URL(url).pathname);
                        const filePath = path.join(attachmentsFolderPath, fileName);

                        try {
                            await downloadAttachment(url, filePath);
                        } catch (error) {
                            console.error(`Error downloading attachment for message ID: ${msgId}`, error);
                        }
                    }
                }
            }

            messageCount += fetchedMessages.size;
            if (messageCount % 50 === 0) {
                console.log(`[${channel.name}] ${messageCount} messages processed so far.`);
            }

        } catch (error) {
            console.error(`Error fetching messages in channel: ${channel.name}`, error);
            await delay(5000); // Incremental backoff
        }
    }

    const scrubbedMessages = allMessages.map(msg => {
        const cleanedMessage = scrubEmptyFields(msg);
        delete cleanedMessage.author; // Remove author field
        return cleanedMessage;
    });

    fs.writeFileSync(archivePath, JSON.stringify(scrubbedMessages, null, 2));
    fs.writeFileSync(authorsPath, JSON.stringify(authors, null, 2));

    console.log(`Archived all messages and attachments for channel: ${channel.name}`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

// Function to scrub empty fields from a message object
function scrubEmptyFields(obj, seen = new WeakSet()) {
    if (obj && typeof obj === 'object') {
        if (seen.has(obj)) return undefined;
        seen.add(obj);
        const scrubbed = {};
        for (const key in obj) {
            const value = scrubEmptyFields(obj[key], seen);
            if (
                value !== undefined &&
                value !== null &&
                !(
                    key === 'discriminator' ||
                    key === 'avatar' ||
                    key === 'avatarDecorationData' ||
                    key === 'guildId' ||
                    key === 'channelId' ||
                    key === 'thumbnail' ||
                    key === 'video' || 
                    (key === 'flags' && value.bitfield === 0) ||
                    (key === 'type' && value === 0) ||
                    (key === 'position' && value === 0) ||
                    value === false
                )
            ) {
                scrubbed[key] = value;
            }
        }
        return Object.keys(scrubbed).length > 0 ? scrubbed : undefined;
    } else if (Array.isArray(obj)) {
        return obj.length > 0 ? obj.map(item => scrubEmptyFields(item, seen)).filter(item => item !== undefined) : undefined;
    }
    return obj;
}

client.login(TOKEN);
