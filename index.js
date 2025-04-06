const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { archiveChannel, initializeDatabaseIfNeeded } = require('./archive');
const { createCommandsList, standardCommandsList } = require('./commands');
const tasklist = require('./tasklist');
require('dotenv').config();

// Admin user IDs from .env
const adminUserIds = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

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
            command.addStringOption(option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false)
            );
        } else if (opt.type === 4) { // INTEGER
            command.addIntegerOption(option =>
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required || false)
            );
        }
    });
    
    return command;
}

client.once('ready', () => {
    console.log('Bot is ready!');
    
    const adminCommandsList = createCommandsList(adminUserIds);
    
    // Register all commands when bot starts
    const commands = [
        // Admin commands
        ...Object.entries(adminCommandsList).map(([name, cmd]) => {
            const command = new SlashCommandBuilder()
                .setName(name)
                .setDescription(cmd.description);
            
            return addOptionsToCommand(command, cmd.options).toJSON();
        }),
        
        // Standard commands
        ...Object.entries(standardCommandsList).map(([name, cmd]) => {
            const command = new SlashCommandBuilder()
                .setName(name)
                .setDescription(cmd.description);
            
            return addOptionsToCommand(command, cmd.options).toJSON();
        })
    ];

    client.application.commands.set(commands);
    console.log('Commands registered!');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const adminCommandsList = createCommandsList(adminUserIds);

    // Check if it's an admin command
    if (adminCommandsList[commandName]) {
        if (!adminUserIds.includes(interaction.user.id)) {
            await interaction.reply({ 
                content: "You don't have permission to use this command.",
                ephemeral: true 
            });
            return;
        }
        await adminCommandsList[commandName].execute(interaction);
        return;
    }

    // Check if it's a standard command
    if (standardCommandsList[commandName]) {
        await standardCommandsList[commandName].execute(interaction);
        return;
    }

    // Fallback for archivechannel command
    if (commandName === 'archivechannel') {
        await interaction.deferReply();
        
        try {
            await initializeDatabaseIfNeeded(interaction.guildId);
            const archivePath = await archiveChannel(interaction.channel);
            
            if (archivePath) {
                await interaction.editReply('Channel archived successfully!');
            } else {
                await interaction.editReply('No new messages to archive.');
            }
        } catch (error) {
            console.error('Error archiving channel:', error);
            await interaction.editReply('Error archiving channel.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
