/**
 * Discord Channel Archive System
 *
 * Core Functions:
 * - archiveChannel: Main function for fetching and storing messages
 * - initializeDatabaseIfNeeded: Sets up SQLite database for a guild
 * - processNewArchiveFiles: Inserts archived messages into database
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureDirectoryExists,
    saveJsonFile,
    downloadFile,
    delay
} = require('../utils/helper');
const { createLogger } = require('../utils/logger');

const log = createLogger('archive');

async function getLastArchiveTime(guildId, channelId) {
    const dbPath = path.join(__dirname, '..', 'Output', guildId, 'archive.db');

    if (!fs.existsSync(dbPath)) {
        log.info('getLastArchiveTime', { channelId, guildId, lastArchiveTime: 'never (no database)' });
        return 0;
    }

    let db;
    try {
        db = await open({ filename: dbPath, driver: sqlite3.Database });
        const row = await db.get(
            'SELECT MAX(createdTimestamp) as maxTs FROM raw_archive WHERE channel_id = ? AND guild_id = ?',
            [channelId, guildId]
        );
        await db.close();

        const lastTime = row?.maxTs || 0;

        // Sanity check: reject future timestamps
        const now = Date.now();
        if (lastTime > now) {
            log.warn('getLastArchiveTime', {
                reason: 'Future timestamp detected',
                timestamp: new Date(lastTime).toISOString(),
                channelId
            });
            return 0;
        }

        log.info('getLastArchiveTime', {
            channelId,
            guildId,
            lastArchiveTime: lastTime > 0 ? new Date(lastTime).toISOString() : 'never'
        });
        return lastTime;
    } catch (err) {
        if (db) await db.close().catch(() => {});
        log.error('getLastArchiveTime', err, { channelId, guildId });
        return 0;
    }
}

async function updateReactionData(messages) {
    log.info('updateReactionData', { messageCount: messages.length });
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
            log.error('updateReactionData', error, {
                batchStart: i,
                batchEnd: i + 100
            });
        }
        await delay(1000); // Rate limit protection
    }

    // Update reaction data for each message
    let reactionsAdded = 0;
    for (const message of messages) {
        const fetchedMessage = messageMap.get(message.id);
        if (fetchedMessage && fetchedMessage.reactions.cache.size > 0) {
            const reactions = [];
            for (const reaction of fetchedMessage.reactions.cache.values()) {
                try {
                    const users = await reaction.users.fetch();
                    reactions.push({
                        emoji: {
                            name: reaction.emoji.name,
                            id: reaction.emoji.id || null,
                            animated: reaction.emoji.animated || false
                        },
                        count: reaction.count,
                        users: users.map(user => user.id)
                    });
                } catch (error) {
                    log.error('updateReactionData', error, { messageId: message.id });
                }
            }
            message.reactions = reactions;
            reactionsAdded++;
        }
    }

    log.success('updateReactionData', { messagesWithReactions: reactionsAdded });
}

const NEW_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS raw_archive (
        id TEXT PRIMARY KEY,
        createdTimestamp INTEGER,
        content TEXT,
        author_id TEXT,
        guild_id TEXT,
        channel_id TEXT,
        channel_name TEXT,
        archive_file TEXT,
        metadata TEXT,
        UNIQUE(id, guild_id)
    );
`;

async function migrateOldSchema(db) {
    log.info('migrateOldSchema', { status: 'starting migration' });
    await db.run('BEGIN TRANSACTION');
    try {
        await db.exec(`
            CREATE TABLE raw_archive_new (
                id TEXT PRIMARY KEY,
                createdTimestamp INTEGER,
                content TEXT,
                author_id TEXT,
                guild_id TEXT,
                channel_id TEXT,
                channel_name TEXT,
                archive_file TEXT,
                metadata TEXT,
                UNIQUE(id, guild_id)
            );
        `);

        const rows = await db.all('SELECT * FROM raw_archive');
        for (const row of rows) {
            const metadata = {};
            if (row.mentions && row.mentions !== '{}') {
                try { metadata.mentions = JSON.parse(row.mentions); } catch (e) { /* skip invalid */ }
            }
            if (row.reference && row.reference !== '{}') {
                try { metadata.reference = JSON.parse(row.reference); } catch (e) { /* skip invalid */ }
            }
            if (row.reactions && row.reactions !== '[]') {
                try { metadata.reactions = JSON.parse(row.reactions); } catch (e) { /* skip invalid */ }
            }
            if (row.embeds && row.embeds !== '{}') {
                try { metadata.embeds = JSON.parse(row.embeds); } catch (e) { /* skip invalid */ }
            }
            if (row.data && row.data !== '{}') {
                try {
                    const extra = JSON.parse(row.data);
                    Object.assign(metadata, extra);
                } catch (e) { /* skip invalid */ }
            }

            await db.run(
                `INSERT INTO raw_archive_new (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.createdTimestamp, row.content, row.author_id, row.guild_id,
                    row.channel_id, row.channel_name, row.archive_file,
                    Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null]
            );
        }

        await db.exec('DROP TABLE raw_archive');
        await db.exec('ALTER TABLE raw_archive_new RENAME TO raw_archive');
        await db.run('COMMIT');
        log.success('migrateOldSchema', { rowsMigrated: rows.length });
    } catch (error) {
        await db.run('ROLLBACK');
        log.error('migrateOldSchema', error);
        throw error;
    }
}

async function initSchemaMeta(db, version) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);
    await db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)", [version]);
    await db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_updated', datetime('now'))");
}

async function initializeDatabaseIfNeeded(guildId) {
    const dbPath = path.join(__dirname, '..', 'Output', guildId, 'archive.db');
    ensureDirectoryExists(path.dirname(dbPath));

    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    const tableExists = await db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='raw_archive'"
    );

    // Performance pragmas
    await db.run('PRAGMA journal_mode=WAL');
    await db.run('PRAGMA auto_vacuum=FULL');

    if (!tableExists) {
        log.info('initializeDatabase', { guildId, status: 'creating new database' });
        await db.exec(NEW_SCHEMA_SQL);
        await initSchemaMeta(db, '2');
        log.success('initializeDatabase', { guildId });
    } else {
        // Check if migration needed (old schema has 'mentions' column)
        const columns = await db.all('PRAGMA table_info(raw_archive)');
        const hasOldSchema = columns.some(c => c.name === 'mentions');

        if (hasOldSchema) {
            log.info('initializeDatabase', { guildId, status: 'migrating old schema' });
            await migrateOldSchema(db);
            await initSchemaMeta(db, '2');
        } else {
            log.info('initializeDatabase', { guildId, status: 'already up to date' });
            // Ensure schema_meta exists for older DBs that were created before versioning
            await initSchemaMeta(db, '2');
        }
    }

    await db.close();
}

async function archiveChannel(channel, options = { saveMessages: true, saveAttachments: true }) {
    const timestamp = Date.now();
    const lastArchiveTime = await getLastArchiveTime(channel.guild.id, channel.id);

    log.info('archiveChannel', {
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guild.id,
        lastArchiveTime: lastArchiveTime > 0 ? new Date(lastArchiveTime).toISOString() : 'never'
    });

    // Setup folders
    const folderName = `${channel.name}_${channel.id}`;
    const baseFolderPath = path.join(__dirname, '..', 'Output', channel.guild.id, folderName);
    const attachmentsFolderPath = path.join(baseFolderPath, 'attachments');
    ensureDirectoryExists(baseFolderPath);
    if (options.saveAttachments) {
        ensureDirectoryExists(attachmentsFolderPath);
    }

    // Get all messages since last archive
    const allMessages = await fetchMessageBatch(channel, lastArchiveTime);
    if (allMessages.length === 0) {
        log.info('archiveChannel', {
            channelId: channel.id,
            channelName: channel.name,
            result: 'No new messages'
        });
        return null;
    }

    log.info('archiveChannel', {
        channelId: channel.id,
        messageCount: allMessages.length,
        phase: 'fetched messages'
    });

    // Handle attachments if enabled
    let attachmentsDownloaded = 0;
    let attachmentsFailed = 0;
    if (options.saveAttachments) {
        for (const message of allMessages) {
            if (message.attachments.size > 0) {
                for (const [id, attachment] of message.attachments) {
                    const attachmentPath = path.join(attachmentsFolderPath, attachment.name);
                    try {
                        await downloadFile(attachment.url, attachmentPath);
                        attachmentsDownloaded++;
                    } catch (error) {
                        attachmentsFailed++;
                        log.error('archiveChannel', error, {
                            phase: 'download attachment',
                            attachmentName: attachment.name
                        });
                    }
                    await delay(1000); // Rate limit protection
                }
            }
        }
        if (attachmentsDownloaded > 0 || attachmentsFailed > 0) {
            log.info('archiveChannel', {
                phase: 'attachments',
                downloaded: attachmentsDownloaded,
                failed: attachmentsFailed
            });
        }
    }

    // Update reactions
    await updateReactionData(allMessages);

    // Save to files
    const archivePath = path.join(baseFolderPath, `archive_${timestamp}.json`);
    const authorsPath = path.join(baseFolderPath, `authors_${timestamp}.json`);

    const scrubbedMessages = scrubMessages(allMessages);
    const authorsMap = createAuthorsMap(allMessages);

    saveJsonFile(archivePath, scrubbedMessages);
    saveJsonFile(authorsPath, authorsMap);

    // Log the archive step
    const logPath = path.join(__dirname, '..', 'Output', 'log.csv');
    if (!fs.existsSync(logPath)) {
        ensureDirectoryExists(path.dirname(logPath));
        fs.writeFileSync(logPath, 'Task,GuildId,ChannelID,Timestamp\n');
    }
    fs.appendFileSync(logPath, `archive,${channel.guild.id},${channel.id},${timestamp}\n`);

    // Insert into database
    const db = await open({
        filename: path.join(__dirname, '..', 'Output', channel.guild.id, 'archive.db'),
        driver: sqlite3.Database
    });
    await processNewArchiveFiles(db, channel.guild.id, baseFolderPath);
    await db.close();

    log.success('archiveChannel', {
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guild.id,
        messageCount: allMessages.length,
        attachmentsDownloaded,
        archivePath
    });

    return archivePath;
}

async function fetchMessageBatch(channel, lastArchiveTime) {
    log.debug('fetchMessageBatch', {
        channelId: channel.id,
        after: lastArchiveTime > 0 ? new Date(lastArchiveTime).toISOString() : 'beginning'
    });

    const allMessages = [];
    let lastId = null;
    let keepFetching = true;
    let batchCount = 0;

    while (keepFetching) {
        const options = { limit: 100 };
        if (lastId) {
            options.before = lastId;
        }

        const messages = await channel.messages.fetch(options);
        batchCount++;

        if (messages.size === 0) {
            break;
        }

        for (const message of messages.values()) {
            // Convert both timestamps to milliseconds for comparison
            if (message.createdTimestamp > lastArchiveTime) {
                allMessages.push(message);
            } else {
                keepFetching = false;
                break;
            }
        }

        lastId = messages.last()?.id;
        await delay(1000); // Rate limit protection
    }

    log.info('fetchMessageBatch', {
        channelId: channel.id,
        messageCount: allMessages.length,
        batchesFetched: batchCount
    });

    return allMessages;
}

function scrubMessages(messages) {
    return messages.map(msg => {
        const scrubbed = {
            id: msg.id,
            createdTimestamp: msg.createdTimestamp,
            content: msg.content
        };

        const metadata = {};

        // Reactions (already processed by updateReactionData into a flat array)
        if (msg.reactions && Array.isArray(msg.reactions) && msg.reactions.length > 0) {
            metadata.reactions = msg.reactions.map(reaction => {
                const emoji = typeof reaction.emoji === 'string'
                    ? { name: reaction.emoji, id: null, animated: false }
                    : {
                        name: reaction.emoji?.name || reaction.emoji,
                        id: reaction.emoji?.id || null,
                        animated: reaction.emoji?.animated || false
                    };
                return { emoji, count: reaction.count, users: reaction.users || [] };
            });
        }

        // Reply reference
        if (msg.reference) {
            metadata.reference = {
                messageId: msg.reference.messageId,
                channelId: msg.reference.channelId,
                guildId: msg.reference.guildId
            };
        }

        // Attachments metadata
        if (msg.attachments) {
            const attachments = msg.attachments instanceof Map
                ? Array.from(msg.attachments.values())
                : (Array.isArray(msg.attachments) ? msg.attachments : []);
            if (attachments.length > 0) {
                metadata.attachments = attachments.map(a => ({
                    id: a.id,
                    name: a.name,
                    url: a.url,
                    size: a.size,
                    contentType: a.contentType || null
                }));
            }
        }

        // Embeds
        if (msg.embeds) {
            const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
            if (embeds.length > 0) {
                metadata.embeds = embeds.map(e => e.data || e.toJSON?.() || e);
            }
        }

        // Mentions
        if (msg.mentions) {
            if (msg.mentions.users || msg.mentions.roles || msg.mentions.everyone !== undefined) {
                const mentionData = {};
                if (msg.mentions.users?.size > 0) {
                    mentionData.users = Array.from(msg.mentions.users.values()).map(u => ({ id: u.id, username: u.username }));
                } else if (Array.isArray(msg.mentions.users) && msg.mentions.users.length > 0) {
                    mentionData.users = msg.mentions.users;
                }
                if (msg.mentions.everyone) mentionData.everyone = true;
                if (msg.mentions.repliedUser) {
                    mentionData.repliedUser = {
                        id: msg.mentions.repliedUser.id,
                        username: msg.mentions.repliedUser.username,
                        globalName: msg.mentions.repliedUser.globalName
                    };
                }
                if (Object.keys(mentionData).length > 0) {
                    metadata.mentions = mentionData;
                }
            } else if (typeof msg.mentions === 'object' && Object.keys(msg.mentions).length > 0) {
                metadata.mentions = msg.mentions;
            }
        }

        // Message type (0 = DEFAULT — skip default)
        if (msg.type && msg.type !== 0) {
            metadata.type = msg.type;
        }

        // Edited timestamp
        if (msg.editedTimestamp) {
            metadata.editedTimestamp = msg.editedTimestamp;
        }

        // Flags (bitfield)
        if (msg.flags) {
            const bitfield = typeof msg.flags === 'object' ? msg.flags.bitfield : msg.flags;
            if (bitfield && bitfield !== 0) {
                metadata.flags = bitfield;
            }
        }

        // Pinned
        if (msg.pinned) {
            metadata.pinned = true;
        }

        // System message
        if (msg.system) {
            metadata.system = true;
        }

        // Webhook/application data
        if (msg.webhookId) metadata.webhookId = msg.webhookId;
        if (msg.applicationId) metadata.applicationId = msg.applicationId;

        // Interaction metadata
        if (msg.interaction) {
            metadata.interaction = {
                id: msg.interaction.id,
                type: msg.interaction.type,
                commandName: msg.interaction.commandName
            };
        }
        if (msg.interactionMetadata) {
            metadata.interactionMetadata = msg.interactionMetadata;
        }

        // Position (thread ordering)
        if (msg.position !== undefined && msg.position !== null && msg.position !== 0) {
            metadata.position = msg.position;
        }

        // Nonce
        if (msg.nonce) {
            metadata.nonce = msg.nonce;
        }

        // Only add metadata if there's something in it
        if (Object.keys(metadata).length > 0) {
            scrubbed.metadata = metadata;
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

function parseChannelFolder(channelPath) {
    const folderName = path.basename(channelPath);
    // Channel ID is always the last underscore-separated segment (it's a snowflake)
    const channelId = folderName.split('_').pop();
    const channelName = folderName.split('_').slice(0, -1).join('_');
    return { channelId, channelName };
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

function validateRow(msg, authorId) {
    const errors = [];

    // Presence + type
    if (!msg.id || typeof msg.id !== 'string') {
        errors.push('missing or invalid id');
    } else if (!SNOWFLAKE_RE.test(msg.id)) {
        errors.push('id is not a snowflake: ' + msg.id);
    }

    if (!msg.createdTimestamp || typeof msg.createdTimestamp !== 'number') {
        errors.push('missing or invalid createdTimestamp');
    } else {
        if (!Number.isInteger(msg.createdTimestamp)) {
            errors.push('createdTimestamp is float');
        }
        if (msg.createdTimestamp < 1420070400000) {
            errors.push('createdTimestamp before Discord epoch');
        }
        if (msg.createdTimestamp > 1893456000000) {
            errors.push('createdTimestamp after 2030');
        }
    }

    if (authorId && !SNOWFLAKE_RE.test(authorId)) {
        errors.push('author_id is not a snowflake: ' + authorId);
    }

    return errors;
}

function buildMetadata(msg) {
    if (msg.metadata) return msg.metadata;

    const coreKeys = new Set(['id', 'createdTimestamp', 'content']);
    const metadata = {};
    for (const [key, value] of Object.entries(msg)) {
        if (!coreKeys.has(key) && value !== undefined && value !== null) {
            metadata[key] = value;
        }
    }
    return metadata;
}

async function processNewArchiveFiles(db, guildId, channelPath) {
    const { channelId, channelName } = parseChannelFolder(channelPath);

    try {
        const archiveFiles = fs.readdirSync(channelPath)
            .filter(file => file.startsWith('archive_') && file.endsWith('.json'));

        if (archiveFiles.length === 0) {
            log.info('processNewArchiveFiles', { guildId, channelId, result: 'No archive files' });
            return { inserted: 0, skipped: 0, invalid: 0 };
        }

        log.info('processNewArchiveFiles', { guildId, channelId, fileCount: archiveFiles.length });
        await db.run('BEGIN TRANSACTION');

        let totalMessages = 0;
        let skippedNoAuthor = 0;
        let invalidMessages = 0;

        for (const archiveFile of archiveFiles) {
            const authorsFile = archiveFile.replace('archive_', 'authors_');
            const archivePath = path.join(channelPath, archiveFile);
            const authorsPath = path.join(channelPath, authorsFile);

            if (!fs.existsSync(archivePath) || !fs.existsSync(authorsPath)) {
                log.warn('processNewArchiveFiles', {
                    file: archiveFile,
                    reason: 'Missing authors file'
                });
                continue;
            }

            let archiveData, authorsData;
            try {
                archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
                authorsData = JSON.parse(fs.readFileSync(authorsPath, 'utf-8'));
            } catch (parseErr) {
                log.error('processNewArchiveFiles', parseErr, {
                    file: archiveFile,
                    reason: 'JSON parse error'
                });
                continue;
            }

            if (!Array.isArray(archiveData)) {
                log.warn('processNewArchiveFiles', {
                    file: archiveFile,
                    reason: 'Archive data is not an array'
                });
                continue;
            }

            // Build reverse lookup: msgId -> author (much faster than .find() per message)
            const msgToAuthor = new Map();
            for (const author of Object.values(authorsData)) {
                if (author.msgIds) {
                    for (const mid of author.msgIds) {
                        msgToAuthor.set(mid, author);
                    }
                }
            }

            for (const msg of archiveData) {
                // Validate required fields
                const author = msgToAuthor.get(msg.id);
                const errors = validateRow(msg, author ? author.id : null);
                if (errors.length > 0) {
                    invalidMessages++;
                    log.warn('processNewArchiveFiles', {
                        msgId: msg.id || 'unknown',
                        file: archiveFile,
                        reason: 'validation failed',
                        errors
                    });
                    continue;
                }

                if (!author) {
                    skippedNoAuthor++;
                    continue;
                }

                const metadata = buildMetadata(msg);
                const metadataStr = Object.keys(metadata).length > 0
                    ? JSON.stringify(metadata)
                    : null;

                await db.run(
                    `INSERT OR REPLACE INTO raw_archive
                     (id, createdTimestamp, content, author_id, guild_id, channel_id, channel_name, archive_file, metadata)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        msg.id,
                        msg.createdTimestamp,
                        msg.content,
                        author.id,
                        guildId,
                        channelId,
                        channelName,
                        archiveFile,
                        metadataStr
                    ]
                );
                totalMessages++;
            }
        }

        await db.run('COMMIT');

        const result = { inserted: totalMessages, skipped: skippedNoAuthor, invalid: invalidMessages };
        log.success('processNewArchiveFiles', {
            guildId,
            channelId,
            filesProcessed: archiveFiles.length,
            ...result
        });
        return result;
    } catch (error) {
        await db.run('ROLLBACK');
        log.error('processNewArchiveFiles', error, { guildId, channelId });
        throw error;
    }
}

// ============ Scheduled Action Handlers ============

async function executeAction(action, channel) {
    const guild = channel.guild;

    if (action === 'archive_server') {
        await archiveServer(guild, channel);
    } else if (action === 'archive_channel') {
        await archiveSingleChannel(channel);
    } else {
        log.warn('executeAction', { reason: 'Unknown archive action', action });
    }
}

async function archiveServer(guild, statusChannel, options = { saveMessages: true, saveAttachments: true }) {
    await initializeDatabaseIfNeeded(guild.id);

    const textChannels = guild.channels.cache.filter(ch => ch.type === 0);
    const total = textChannels.size;
    let processed = 0;
    let archived = 0;
    let skipped = 0;
    let errors = 0;

    await statusChannel.send(`Starting server archive — ${total} text channel(s) to process.`);

    for (const [, ch] of textChannels) {
        try {
            const result = await archiveChannel(ch, options);
            processed++;
            if (result) {
                archived++;
                await statusChannel.send(`[${processed}/${total}] #${ch.name} — archived`);
            } else {
                skipped++;
            }
        } catch (err) {
            processed++;
            errors++;
            log.error('archiveServer', err, { channelId: ch.id, channelName: ch.name });
            await statusChannel.send(`[${processed}/${total}] #${ch.name} — error: ${err.message}`);
        }
    }

    await statusChannel.send(
        `Archive complete: ${archived} archived, ${skipped} skipped (no new messages), ${errors} error(s) — ${total} channels total.`
    );
}

async function archiveSingleChannel(channel) {
    await initializeDatabaseIfNeeded(channel.guild.id);
    await archiveChannel(channel, { saveMessages: true, saveAttachments: true });
}

module.exports = {
    initializeDatabaseIfNeeded,
    archiveChannel,
    archiveServer,
    updateReactionData,
    processNewArchiveFiles,
    migrateOldSchema,
    executeAction,
    // Pure functions exported for testing
    scrubMessages,
    createAuthorsMap,
    getLastArchiveTime,
    parseChannelFolder,
    validateRow,
    buildMetadata,
};
