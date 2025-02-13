const { Client, GatewayIntentBits, REST, Routes, Events, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const tasklist = require('./tasklist');
const { archiveChannel, initializeDatabaseIfNeeded } = require('./archive');
const fs = require('fs');

const { adminCommandsList, standardCommandsList } = require('./commands');

require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Admin user IDs from .env
const adminUserIds = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

// Command handlers map
const adminCommands = new Map();
const standardCommands = new Map();

// Add commands to Maps
Object.entries(adminCommandsList).forEach(([name, command]) => {
    adminCommands.set(name, command);
});

Object.entries(standardCommandsList).forEach(([name, command]) => {
    standardCommands.set(name, command);
});

// Convert commands to slash command format
const slashCommands = [
    ...Object.entries(adminCommandsList).map(([name, cmd]) => ({
        name,
        description: cmd.description,
        type: 1, // CHAT_INPUT
        defaultPermission: false, // Admin commands are restricted by default
    })),
    ...Object.entries(standardCommandsList).map(([name, cmd]) => ({
        name,
        description: cmd.description,
        type: 1, // CHAT_INPUT
    })),
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: slashCommands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
}

// Handle interactions (slash commands)
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    // Check if it's an admin command
    if (adminCommandsList[commandName]) {
        if (!adminUserIds.includes(interaction.user.id)) {
            await interaction.reply({ 
                content: "Insufficient permission, please contact an admin.",
                ephemeral: true 
            });
            return;
        }

        try {
            await adminCommandsList[commandName].execute(interaction);
        } catch (error) {
            console.error(`Error executing admin command ${commandName}:`, error);
            await interaction.reply({ 
                content: 'There was an error executing that command.',
                ephemeral: true 
            });
        }
        return;
    }

    // Check if it's a standard command
    if (standardCommandsList[commandName]) {
        try {
            await standardCommandsList[commandName].execute(interaction);
        } catch (error) {
            console.error(`Error executing standard command ${commandName}:`, error);
            await interaction.reply({ 
                content: 'There was an error executing that command.',
                ephemeral: true 
            });
        }
        return;
    }

    // Handle task commands
    if (tasklist.isTaskCommand(commandName)) {
        try {
            await tasklist.handleSlashCommand(interaction, adminUserIds);
        } catch (error) {
            console.error(`Error executing task command ${commandName}:`, error);
            await interaction.reply({ 
                content: `There was an error processing the command: ${commandName}`,
                ephemeral: true 
            });
        }
    }

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

client.once(Events.ClientReady, async client => {
    console.log(`Logged in as ${client.user.tag}`);

    // Initialize databases for all guilds that have archives
    const outputDir = path.join(__dirname, 'Output');
    if (fs.existsSync(outputDir)) {
        const guildDirs = fs.readdirSync(outputDir).filter(f => 
            fs.statSync(path.join(outputDir, f)).isDirectory()
        );

        for (const guildId of guildDirs) {
            console.log(`Initializing database for guild ${guildId}...`);
            await initializeDatabaseIfNeeded(guildId);
        }
    }

    console.log('All databases initialized');

    // Register commands when bot starts
    const archiveCommand = new SlashCommandBuilder()
        .setName('archivechannel')
        .setDescription('Archives all messages in the current channel')
        .addBooleanOption(option =>
            option.setName('attachments')
                .setDescription('Whether to download attachments')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('messages')
                .setDescription('Whether to archive messages')
                .setRequired(false));

    client.application.commands.set([archiveCommand]);
    console.log('Commands registered!');
});

client.login(TOKEN);
