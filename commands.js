const archive = require('./lib/archive');
const tasklist = require('./lib/tasklist');
const colorroles = require('./lib/colorroles');
const permissions = require('./lib/permissions');

function createCommandsList() {
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
            }, {
                name: 'tag',
                description: 'Category tag for the task',
                type: 3, // STRING type
                required: false
            }],
            execute: async (interaction) => {
                try {
                    await tasklist.handleSlashCommand(interaction);
                } catch (error) {
                    console.error('Error in task command:', error);
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: `Error: ${error.message}`,
                            ephemeral: true
                        });
                    } else if (interaction.deferred) {
                        await interaction.editReply({
                            content: `Error: ${error.message}`
                        });
                    }
                }
            }
        },
        done: {
            description: 'Mark tasks as completed or create and complete a new task',
            options: [{
                name: 'name',
                description: 'Task IDs (1,2,3) or descriptions ("task 1", "task 2")',
                type: 3,  // STRING type
                required: true
            }, {
                name: 'category',
                description: 'Category tag for the task',
                type: 3, // STRING type
                required: false
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        take: {
            description: 'Take a task',
            options: [{
                name: 'name',
                description: 'Task IDs (1,2,3) or descriptions ("task 1", "task 2")',
                type: 3, // STRING type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        init: {
            description: 'Initialize the task system',
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        delete: {
            description: 'Delete a task',
            options: [{
                name: 'id',
                description: 'Task IDs to delete (comma-separated)',
                type: 3, // STRING type
                required: true
            }],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        tag: {
            description: 'Tag a category to tasks',
            options: [
                {
                    name: 'category',
                    description: 'The category name to apply',
                    type: 3, // STRING type
                    required: true
                },
                {
                    name: 'id',
                    description: 'Task IDs to tag (comma-separated)',
                    type: 3, // STRING type
                    required: true
                }
            ],
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        history: {
            description: 'Display task history',
            execute: async (interaction) => {
                await tasklist.handleSlashCommand(interaction);
            }
        },
        assign: {
            description: 'Assign a permission type to a user',
            options: [
                {
                    name: 'type',
                    description: 'The permission type to assign',
                    type: 3, // STRING type
                    required: true,
                    choices: [
                        { name: 'Admin', value: 'admin' },
                        { name: 'Task', value: 'task' }
                    ]
                },
                {
                    name: 'user',
                    description: 'The user to assign the permission to',
                    type: 6, // USER type
                    required: true
                },
                {
                    name: 'remove',
                    description: 'Remove the permission instead of adding it',
                    type: 5, // BOOLEAN type
                    required: false
                }
            ],
            execute: async (interaction) => {
                // Check if the user has admin permissions
                const hasAdminPerms = await permissions.hasAdminAccess(
                    interaction.user.id, 
                    interaction.guild
                );
                
                if (!hasAdminPerms) {
                    await interaction.reply({
                        content: "You don't have permission to use this command.",
                        ephemeral: true
                    });
                    return;
                }
                
                // Get the parameters from the interaction
                const permissionType = interaction.options.getString('type');
                const targetUser = interaction.options.getUser('user');
                const remove = interaction.options.getBoolean('remove') || false;
                
                // Set the permission
                try {
                    await interaction.deferReply({ ephemeral: true });
                    
                    const result = await permissions.setPermission(
                        targetUser.id,
                        interaction.guild.id,
                        permissionType,
                        remove
                    );
                    
                    // Generate the success message
                    const action = remove ? "removed from" : "added to";
                    const message = `Successfully ${action} ${permissionType} permissions: ${targetUser.username} (${targetUser.id})`;
                    
                    await interaction.editReply({
                        content: message,
                        ephemeral: true
                    });
                    
                    // If we need to refresh commands, do it now
                    if (result.needsRefresh) {
                        try {
                            // Register commands for this guild
                            const { client } = interaction;
                            
                            // Import needed functions from index.js
                            // This is a bit of a hack, but it works in this context
                            const { registerGuildCommands } = require('./index.js');
                            
                            // Register commands for this specific guild
                            await registerGuildCommands(client, interaction.guild);
                            
                            await interaction.followUp({
                                content: "Commands refreshed successfully! Users may need to restart their Discord client to see changes.",
                                ephemeral: true
                            });
                        } catch (error) {
                            console.error('Error refreshing commands:', error);
                            await interaction.followUp({
                                content: "Permission updated, but there was an error refreshing commands. The bot may need to be restarted.",
                                ephemeral: true
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error setting permission:', error);
                    
                    const errorMessage = error.message || "An unknown error occurred";
                    
                    if (interaction.deferred) {
                        await interaction.editReply({
                            content: `Error: ${errorMessage}`,
                            ephemeral: true
                        });
                    } else {
                        await interaction.reply({
                            content: `Error: ${errorMessage}`,
                            ephemeral: true
                        });
                    }
                }
            }
        },
        permissions: {
            description: 'List users with specific permissions',
            options: [
                {
                    name: 'type',
                    description: 'The permission type to list',
                    type: 3, // STRING type
                    required: true,
                    choices: [
                        { name: 'Admin', value: 'admin' },
                        { name: 'Task', value: 'task' }
                    ]
                }
            ],
            execute: async (interaction) => {
                try {
                    // Parse options
                    const permissionType = interaction.options.getString('type');
                    
                    // Verify caller is an admin using both our system and roles
                    const hasAdminPerms = await permissions.hasAdminAccess(
                        interaction.user.id,
                        interaction.guild
                    );
                    
                    if (!hasAdminPerms) {
                        await interaction.reply({
                            content: "You don't have permission to use this command.",
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // Get users with the specified permission
                    const userIds = permissions.getUsersWithPermission(interaction.guild.id, permissionType);
                    
                    if (userIds.length === 0) {
                        await interaction.reply({
                            content: `No users have ${permissionType} permission in this server.`,
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // Fetch user details
                    const userPromises = userIds.map(async (userId) => {
                        try {
                            const user = await interaction.client.users.fetch(userId);
                            return `- ${user.tag} (${userId})`;
                        } catch (e) {
                            return `- Unknown User (${userId})`;
                        }
                    });
                    
                    const userList = await Promise.all(userPromises);
                    
                    await interaction.reply({
                        content: `**Users with ${permissionType} permission:**\n${userList.join('\n')}`,
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error in permissions command:', error);
                    await interaction.reply({
                        content: `An error occurred: ${error.message}`,
                        ephemeral: true
                    });
                }
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
    },
    color: {
        description: 'Set your display color using a color name, role ID, or hex color',
        options: [{
            name: 'color',
            description: 'Color name, role ID, or hex color (e.g., Red, #FF0000)',
            type: 3, // STRING type
            required: true
        }],
        execute: async (interaction) => {
            await colorroles.handleColorCommand(interaction);
        }
    },
    colorshow: {
        description: 'Show available colors and how to use custom colors',
        execute: async (interaction) => {
            await colorroles.handleColorShowCommand(interaction);
        }
    }
};

module.exports = {
    createCommandsList,
    standardCommandsList
}; 