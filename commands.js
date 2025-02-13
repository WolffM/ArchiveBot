const archive = require('./archive');

const adminCommandsList = {
    archivepics: {
        description: 'Archives images from the channel',
        execute: async (interaction) => {
            try {
                await archive.handleArchivePicsCommand(interaction);
            } catch (error) {
                console.error('Error in archivepics command:', error);
                const reply = interaction.deferred ? 
                    interaction.editReply : 
                    interaction.reply;
                await reply.call(interaction, {
                    content: 'An error occurred while archiving images.',
                    ephemeral: true
                });
            }
        },
    },
    archiveall: {
        description: 'Archives all messages from all channels in the server',
        execute: async (interaction) => {
            try {
                await archive.handleArchiveAllCommand(interaction);
            } catch (error) {
                console.error('Error in archiveall command:', error);
                const reply = interaction.deferred ? 
                    interaction.editReply : 
                    interaction.reply;
                await reply.call(interaction, {
                    content: 'An error occurred while archiving channels.',
                    ephemeral: true
                });
            }
        },
    },
    archivemsgs: {
        description: 'Archives messages from the current channel',
        execute: async (interaction) => {
            try {
                await archive.handleArchiveMsgsCommand(interaction);
            } catch (error) {
                console.error('Error in archivemsgs command:', error);
                const reply = interaction.deferred ? 
                    interaction.editReply : 
                    interaction.reply;
                await reply.call(interaction, {
                    content: 'An error occurred while archiving messages.',
                    ephemeral: true
                });
            }
        },
    },
    initlogs: {
        description: 'Initialize logs from existing archives',
        execute: async (interaction) => {
            try {
                await archive.updateReactionData(interaction);
            } catch (error) {
                console.error('Error in initlogs command:', error);
                const reply = interaction.deferred ? 
                    interaction.editReply : 
                    interaction.reply;
                await reply.call(interaction, {
                    content: 'An error occurred while initializing logs.',
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