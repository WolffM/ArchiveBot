const archive = require('./archive');

const adminCommandsList = {
    archivechannel: {
        description: 'Archives content from the current channel',
        options: [
            {
                name: 'content',
                description: 'What content to archive',
                type: 3, // STRING type
                required: true,
                choices: [
                    { name: 'Messages Only', value: 'messages' },
                    { name: 'Attachments Only', value: 'attachments' },
                    { name: 'Both', value: 'both' }
                ]
            }
        ],
        execute: async (interaction) => {
            try {
                const contentOption = interaction.options.getString('content');
                await archive.handleArchiveChannelCommand(interaction, contentOption);
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
                name: 'content',
                description: 'What content to archive',
                type: 3, // STRING type
                required: true,
                choices: [
                    { name: 'Messages Only', value: 'messages' },
                    { name: 'Attachments Only', value: 'attachments' },
                    { name: 'Both', value: 'both' }
                ]
            }
        ],
        execute: async (interaction) => {
            try {
                const contentOption = interaction.options.getString('content');
                await archive.handleArchiveServerCommand(interaction, contentOption);
            } catch (error) {
                console.error('Error in archiveserver command:', error);
                const reply = interaction.deferred ? 
                    interaction.editReply : 
                    interaction.reply;
                await reply.call(interaction, {
                    content: 'An error occurred while archiving the server.',
                    ephemeral: true
                });
            }
        },
    },
};

const standardCommandsList = {
    test: {
        description: 'Logs the user ID to the console',
        execute: async (interaction) => {
            console.log(`User ID: ${interaction.user.id}`);
            await interaction.reply(`User ID logged to console.`);
        }
    },
    myrecap: {
        description: 'Logs the users recap to the channel console',
        execute: async (interaction) => {
            await interaction.deferReply();
            await archive.handleMyRecapCommand(interaction);
        },
    }
};

module.exports = {
    adminCommandsList,
    standardCommandsList,
}; 