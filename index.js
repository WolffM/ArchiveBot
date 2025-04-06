const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { createCommandsList, standardCommandsList } = require('./commands');
const permissions = require('./permissions');
require('dotenv').config();

// Define command categories
const COMMAND_CATEGORIES = {
    DEFAULT: 'default',
    ADMIN: 'admin',
    TASK: 'task'
};

// Map commands to categories
const commandCategories = {
    // Default commands (visible to everyone)
    color: COMMAND_CATEGORIES.DEFAULT,
    colorshow: COMMAND_CATEGORIES.DEFAULT,
    
    // Admin-only commands
    archiveserver: COMMAND_CATEGORIES.ADMIN,
    archivechannel: COMMAND_CATEGORIES.ADMIN,
    init: COMMAND_CATEGORIES.ADMIN,
    test: COMMAND_CATEGORIES.ADMIN,
    assign: COMMAND_CATEGORIES.ADMIN,
    permissions: COMMAND_CATEGORIES.ADMIN,
    
    // Task system commands
    done: COMMAND_CATEGORIES.TASK,
    history: COMMAND_CATEGORIES.TASK,
    tag: COMMAND_CATEGORIES.TASK,
    take: COMMAND_CATEGORIES.TASK,
    tasks: COMMAND_CATEGORIES.TASK,
    task: COMMAND_CATEGORIES.TASK,
    delete: COMMAND_CATEGORIES.TASK
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

/**
 * Helper function to add options to a slash command based on option type
 * @param {Object} command - SlashCommandBuilder object
 * @param {Array} options - Array of option objects
 * @returns {Object} The command with options added
 */
function addOptionsToCommand(command, options) {
    if (!options) return command;
    
    options.forEach(opt => {
        if (opt.type === 5) { // BOOLEAN
            command.addBooleanOption(option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false)
            );
        } else if (opt.type === 3) { // STRING
            const stringOption = option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false);
                    
            // Check for choices
            if (opt.choices && Array.isArray(opt.choices)) {
                command.addStringOption(option => {
                    const o = stringOption(option);
                    opt.choices.forEach(choice => {
                        o.addChoices({ name: choice.name, value: choice.value });
                    });
                    return o;
                });
            } else {
                command.addStringOption(stringOption);
            }
        } else if (opt.type === 4) { // INTEGER
            command.addIntegerOption(option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false)
            );
        } else if (opt.type === 6) { // USER
            command.addUserOption(option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false)
            );
        }
    });
    
    return command;
}

/**
 * Checks if a user should see a command
 * @param {string} userId - User ID to check
 * @param {string} guildId - Guild ID to check in
 * @param {string} commandName - Command name
 * @returns {boolean} Whether the user should see the command
 */
function shouldUserSeeCommand(userId, guildId, commandName) {
    // Get command category
    const category = commandCategories[commandName];
    
    // Default commands are visible to everyone
    if (category === COMMAND_CATEGORIES.DEFAULT) {
        return true;
    }
    
    // Admin commands are only visible to admins
    if (category === COMMAND_CATEGORIES.ADMIN) {
        return permissions.isAdmin(userId, guildId);
    }
    
    // Task commands are only visible to users with task access
    if (category === COMMAND_CATEGORIES.TASK) {
        return permissions.hasTaskAccess(userId, guildId);
    }
    
    // Unknown category, default to visible
    return true;
}

/**
 * Gets the role ID for a permission type in a guild
 * @param {Object} guild - The Discord.js guild object
 * @param {string} permissionType - The permission type ('admin' or 'task')
 * @returns {string|null} - The role ID or null if not found
 */
async function getRoleForPermission(guild, permissionType) {
    try {
        // Try to find the role
        const roleName = permissionType === 'admin' ? 'admin' : 'task';
        let role = guild.roles.cache.find(r => 
            r.name.toLowerCase() === roleName.toLowerCase());
            
        return role ? role.id : null;
    } catch (error) {
        console.error(`Error finding ${permissionType} role:`, error);
        return null;
    }
}

client.once('ready', async () => {
    console.log('Bot is ready!');
    
    const adminCommandsList = createCommandsList();
    
    // Global commands
    const globalCommands = [
        // Standard commands visible to everyone
        ...Object.entries(standardCommandsList)
            .filter(([name]) => commandCategories[name] === COMMAND_CATEGORIES.DEFAULT)
            .map(([name, cmd]) => {
                const command = new SlashCommandBuilder()
                    .setName(name)
                    .setDescription(cmd.description);
                
                return addOptionsToCommand(command, cmd.options).toJSON();
            })
    ];

    // Register global commands
    await client.application.commands.set(globalCommands);
    console.log('Global commands registered!');
    
    // Log how many guilds we're in 
    console.log(`Bot is in ${client.guilds.cache.size} guilds`);
    
    // Prepare guild-specific commands
    for (const guild of client.guilds.cache.values()) {
        try {
            // Find the admin and task roles
            const adminRoleId = await getRoleForPermission(guild, 'admin');
            const taskRoleId = await getRoleForPermission(guild, 'task');
            
            // Log which roles were found
            console.log(`Guild ${guild.name}: Admin role: ${adminRoleId ? 'Found' : 'Not found'}, Task role: ${taskRoleId ? 'Found' : 'Not found'}`);
            
            // Admin commands - visible to those with admin role
            const adminCmds = Object.entries(adminCommandsList)
                .map(([name, cmd]) => {
                    const command = new SlashCommandBuilder()
                        .setName(name)
                        .setDescription(cmd.description);
                        
                    // Set appropriate permissions based on what we found
                    if (adminRoleId) {
                        // If we found an admin role, administrators or specific role can use
                        // Use "0" to restrict to no one by default
                        command.setDefaultMemberPermissions('0');
                        // Permissions will be handled through our permissions.js checks
                    } else {
                        // Fall back to requiring Administrator permission if no role found
                        command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
                    }
                    
                    return addOptionsToCommand(command, cmd.options).toJSON();
                });
                
            // Task system commands - visible to those with task role
            const taskCmds = Object.entries(standardCommandsList)
                .filter(([name]) => commandCategories[name] === COMMAND_CATEGORIES.TASK)
                .map(([name, cmd]) => {
                    const command = new SlashCommandBuilder()
                        .setName(name)
                        .setDescription(cmd.description);
                    
                    // Set appropriate permissions based on what we found
                    if (taskRoleId || adminRoleId) {
                        // If we found task or admin roles, restrict by default
                        // Use "0" to restrict to no one by default
                        command.setDefaultMemberPermissions('0');
                        // Permissions will be handled through our permissions.js checks
                    } else {
                        // Fall back to a reasonable default permission if no roles found
                        command.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
                    }
                    
                    return addOptionsToCommand(command, cmd.options).toJSON();
                });
            
            // Register all guild commands
            await guild.commands.set([...adminCmds, ...taskCmds]);
            
            // Log which commands were registered
            console.log(`Registered ${adminCmds.length} admin commands and ${taskCmds.length} task commands for guild ${guild.name}`);
            
            // The permissions.set approach is deprecated in newer Discord.js versions
            // We're using defaultMemberPermissions instead
            // No need to set permissions after registration
        } catch (error) {
            console.error(`Error registering commands for guild ${guild.name}:`, error);
        }
    }
    
    console.log('Guild-specific commands registered!');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const adminCommandsList = createCommandsList();

    // Check if it's an admin command
    if (adminCommandsList[commandName]) {
        // Check for admin permission from our system and roles
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
        
        await adminCommandsList[commandName].execute(interaction);
        return;
    }

    // Check if it's a task system command
    if (commandCategories[commandName] === COMMAND_CATEGORIES.TASK) {
        // Check for task permission from both our system and roles
        const hasTaskPerms = await permissions.checkTaskAccessWithRoles(
            interaction.user.id, 
            interaction.guild
        );
        
        if (!hasTaskPerms) {
            await interaction.reply({ 
                content: "You don't have access to the task system. Please ask an admin for access.",
                ephemeral: true 
            });
            return;
        }
    }

    // Standard command execution
    if (standardCommandsList[commandName]) {
        await standardCommandsList[commandName].execute(interaction);
        return;
    }

    // Fallback for unknown commands
    await interaction.reply({
        content: "Command not found.",
        ephemeral: true
    });
});

// Register commands for a specific guild
async function registerGuildCommands(client, guild) {
    // Get role IDs for this guild
    const { adminRoleId, taskRoleId } = await permissions.loadRoleIds(guild);
    console.log(`Guild ${guild.name}: Admin role: ${adminRoleId ? 'Found' : 'Not found'}, Task role: ${taskRoleId ? 'Found' : 'Not found'}`);
    
    try {
        // Admin commands - visible to those with admin role
        const adminCmds = Object.entries(adminCommandsList)
            .map(([name, cmd]) => {
                const command = new SlashCommandBuilder()
                    .setName(name)
                    .setDescription(cmd.description);
                    
                // Set appropriate permissions based on what we found
                if (adminRoleId) {
                    // If we found an admin role, administrators or specific role can use
                    // Use "0" to restrict to no one by default
                    command.setDefaultMemberPermissions('0');
                    // Permissions will be handled through our permissions.js checks
                } else {
                    // Fall back to requiring Administrator permission if no role found
                    command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
                }
                
                return addOptionsToCommand(command, cmd.options).toJSON();
            });
            
        // Task system commands - visible to those with task role
        const taskCmds = Object.entries(standardCommandsList)
            .filter(([name]) => commandCategories[name] === COMMAND_CATEGORIES.TASK)
            .map(([name, cmd]) => {
                const command = new SlashCommandBuilder()
                    .setName(name)
                    .setDescription(cmd.description);
                
                // Set appropriate permissions based on what we found
                if (taskRoleId || adminRoleId) {
                    // If we found task or admin roles, restrict by default
                    // Use "0" to restrict to no one by default
                    command.setDefaultMemberPermissions('0');
                    // Permissions will be handled through our permissions.js checks
                } else {
                    // Fall back to a reasonable default permission if no roles found
                    command.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
                }
                
                return addOptionsToCommand(command, cmd.options).toJSON();
            });
        
        // Register all guild commands
        await guild.commands.set([...adminCmds, ...taskCmds]);
        
        // Log which commands were registered
        console.log(`Registered ${adminCmds.length} admin commands and ${taskCmds.length} task commands for guild ${guild.name}`);
        
        // The permissions.set approach is deprecated in newer Discord.js versions
        // We're using defaultMemberPermissions instead
        // No need to set permissions after registration
        
        return true;
    } catch (error) {
        console.error(`Error registering commands for guild ${guild.name}:`, error);
        return false;
    }
}

// Update the exports at the bottom of the file
module.exports = {
    client,
    registerGuildCommands
};

client.login(process.env.DISCORD_TOKEN);
