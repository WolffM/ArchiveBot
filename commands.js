const archive = require('./archive');
const tasklist = require('./tasklist');
const { SlashCommandBuilder } = require('discord.js');

function createCommandsList(adminUserIds) {
    return {
        archivechannel: {
            description: 'Archives content from the current channel',
            options: [
                {
                    name: 'attachments',
                    description: 'Whether to download attachments',
                    type: 5, // BOOLEAN type
                    required: false
                },
                {
                    name: 'messages',
                    description: 'Whether to archive messages',
                    type: 5, // BOOLEAN type
                    required: false
                }
            ],
            execute: async (interaction) => {
                try {
                    await interaction.deferReply();
                    const attachments = interaction.options.getBoolean('attachments') ?? true;
                    const messages = interaction.options.getBoolean('messages') ?? true;
                    
                    await archive.initializeDatabaseIfNeeded(interaction.guildId);
                    const archivePath = await archive.archiveChannel(interaction.channel, {
                        saveMessages: messages,
                        saveAttachments: attachments
                    });
                    
                    if (archivePath) {
                        await interaction.editReply('Channel archived successfully!');
                    } else {
                        await interaction.editReply('No new messages to archive.');
                    }
                } catch (error) {
                    console.error('Error in archivechannel command:', error);
                    const reply = interaction.deferred ? 
                        interaction.editReply : 
                        interaction.reply;
                    await reply.call(interaction, {
                        content: 'An error occurred while archiving the channel.',
                        ephemeral: true
                    });
                }
            },
        },
        archiveserver: {
            description: 'Archives content from all channels in the server',
            options: [
                {
                    name: 'attachments',
                    description: 'Whether to download attachments',
                    type: 5, // BOOLEAN type
                    required: false
                },
                {
                    name: 'messages',
                    description: 'Whether to archive messages',
                    type: 5, // BOOLEAN type
                    required: false
                }
            ],
            execute: async (interaction) => {
                try {
                    await interaction.deferReply();
                    const attachments = interaction.options.getBoolean('attachments') ?? true;
                    const messages = interaction.options.getBoolean('messages') ?? true;
                    
                    await archive.initializeDatabaseIfNeeded(interaction.guildId);
                    
                    let successCount = 0;
                    let errorCount = 0;
                    
                    for (const channel of interaction.guild.channels.cache.values()) {
                        if (channel.type === 0) { // Text channel
                            try {
                                const archivePath = await archive.archiveChannel(channel, {
                                    saveMessages: messages,
                                    saveAttachments: attachments
                                });
                                if (archivePath) successCount++;
                            } catch (error) {
                                console.error(`Error archiving channel ${channel.name}:`, error);
                                errorCount++;
                            }
                        }
                    }
                    
                    await interaction.editReply(
                        `Server archive complete!\n` +
                        `Successfully archived: ${successCount} channels\n` +
                        `Failed to archive: ${errorCount} channels`
                    );
                } catch (error) {
                    console.error('Error in archiveserver command:', error);
                    await interaction.editReply('An error occurred while archiving the server.');
                }
            },
        },
        task: {
            description: 'Add a new task',
            options: [{
                name: 'description',
                description: 'The task description',
                type: 3, // STRING type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        tasks: {
            description: 'Display all tasks',
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        done: {
            description: 'Mark tasks as completed or create and complete a new task',
            options: [{
                name: 'tasks',
                description: 'Task IDs (1,2,3) or descriptions ("task 1", "task 2")',
                type: 3,  // STRING type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        take: {
            description: 'Take a task',
            options: [{
                name: 'tasks',
                description: 'Task IDs (1,2,3) or descriptions ("task 1", "task 2")',
                type: 3, // INTEGER type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        init: {
            description: 'Initialize the task system',
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        delete: {
            description: 'Mark a task as abandoned',
            options: [{
                name: 'tasks',
                description: 'Task IDs to mark as abandoned (comma-separated)',
                type: 3, // STRING type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        },
        tag: {
            description: 'Tag a category to tasks',
            options: [
                {
                    name: 'category',
                    description: 'The category name to Tag',
                    type: 3, // STRING type
                    required: true
                },
                {
                    name: 'tasks',
                    description: 'Task IDs to mark as abandoned (comma-separated)',
                    type: 3, // STRING type
                    required: true
                }
            ],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction, adminUserIds);
            }
        }
    };
}

const standardCommandsList = {
    test: {
        description: 'Tests the bot connection',
        execute: async (interaction) => {
            await interaction.reply({
                content: `Bot is working! User ID: ${interaction.user.id}`,
                ephemeral: true
            });
        }
    },
    myrecap: {
        description: 'Shows your message history recap',
        execute: async (interaction) => {
            await interaction.deferReply();
            await archive.handleMyRecapCommand(interaction);
        },
    }
};

const commands = [
    new SlashCommandBuilder()
        .setName('done')
        .setDescription('Mark tasks as completed or create and complete new tasks')
        .addStringOption(option =>
            option.setName('tasks')
                .setDescription('Task IDs (1,2,3) or descriptions ("task 1", "task 2")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('take')
        .setDescription('Take tasks or create and take new tasks')
        .addStringOption(option =>
            option.setName('tasks')
                .setDescription('Task IDs (1,2,3) or descriptions ("task 1", "task 2")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('task')
        .setDescription('Add new tasks')
        .addStringOption(option =>
            option.setName('description')
                .setDescription('Task descriptions ("task 1", "task 2")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('Delete tasks by ID')
        .addStringOption(option =>
            option.setName('tasks')
                .setDescription('Task IDs to delete (1,2,3)')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Tag a category to tasks')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('The category name to tag')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('tasks')
                .setDescription('Task IDs to mark as abandoned (comma-separated)')
                .setRequired(true)
        )
];

module.exports = {
    createCommandsList,
    standardCommandsList,
    commands
}; 