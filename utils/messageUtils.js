/**
 * Discord message utilities
 */

/**
 * Split long content into chunks that fit Discord's message limit
 * @param {string} content - Content to split
 * @param {number} limit - Character limit per chunk (default 2000)
 * @returns {string[]} Array of content chunks
 */
function splitMessage(content, limit = 2000) {
    const chunks = [];
    let currentChunk = '';

    content.split('\n').forEach((line) => {
        if (currentChunk.length + line.length + 1 > limit) {
            chunks.push(currentChunk);
            currentChunk = '';
        }
        currentChunk += `${line}\n`;
    });

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Truncate string to max length with ellipsis
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncateString(str, maxLength) {
    return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
}

/**
 * Clean up bot task messages from a channel
 * @param {Object} channel - Discord channel object
 * @param {Object} tasksData - Tasks data (unused, kept for compatibility)
 */
async function cleanupTasks(channel, tasksData) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const messagesToDelete = messages.filter(msg =>
            msg.author.bot && (
                msg.content.includes("Your tasks:") ||
                msg.content.includes("**New Tasks**") ||
                msg.content.includes("**Active Tasks**") ||
                msg.content.includes("**Completed Tasks**")
            )
        );

        if (messagesToDelete.size > 0) {
            await channel.bulkDelete(messagesToDelete, true);
        }
    } catch (error) {
        console.error("Failed to clean up messages:", error);
    }
}

module.exports = {
    splitMessage,
    truncateString,
    cleanupTasks
};
