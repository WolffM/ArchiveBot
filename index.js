const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const tasklist = require('./tasklist');
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

// Archive Messages Command
adminCommands.set('archiveMsgs', {
    description: 'Archives messages (without attachments) from the channel',
    execute: handleArchiveMsgsCommand,
});

// Test Command
standardCommands.set('test', {
    description: 'Logs the user ID to the console',
    execute: handleTestCommand,
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
    const taskCommands = ['add', 'done', 'clear', 'delete', 'take', 'init', 'helpt'];
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

    message.channel.send(`Unknown command: ${commandName}`);
});



// Function to handle the archivePics command
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

// Function to handle the archiveAll command
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

// Function to handle the test command
function handleTestCommand(message, args) {
    console.log(`User ID: ${message.author.id}`);
    message.channel.send(`User ID logged to console.`);
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
