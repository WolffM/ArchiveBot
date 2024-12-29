const fs = require('fs');
const path = require('path');

const BASE_PATH = './Output/tasklist';

module.exports = {
    getGuildPath,
    handleNewMessage,
    getDisplayName,
    // Export other functions if needed
};

function getGuildPath(guildId) {
    return path.join(BASE_PATH, guildId);
}

// Get the file path for the users.json file
function getUsersFilePath(guildId) {
    return path.join(getGuildPath(guildId), 'users.json');
}

// Load or initialize the users data
function loadUsers(guildId) {
    const usersFilePath = getUsersFilePath(guildId);
    if (fs.existsSync(usersFilePath)) {
        return JSON.parse(fs.readFileSync(usersFilePath, 'utf-8'));
    }
    return {};
}

function saveUsers(users, guildId) {
    const usersFilePath = getUsersFilePath(guildId);
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
}

// Update or add user data
function updateUser(userId, displayName, guildId) {
    const users = loadUsers(guildId);
    if (!users[userId] || users[userId] !== displayName) {
        users[userId] = displayName;
        saveUsers(users, guildId);
    }
}

// Get display name by userId
function getDisplayName(userId, guildId) {
    const users = loadUsers(guildId);
    return users[userId] || "Unassigned";
}

// Updated task assignment logic
function getAssignedName(task, guildId) {
    if (!task.assigned) return "Unassigned";
    return getDisplayName(task.assigned, guildId);
}

// Example: Handling a new message
function handleNewMessage(message) {
    const userId = message.author.id;
    const displayName = message.author.username; // or displayName depending on context
    const guildId = message.guild.id;
    updateUser(userId, displayName, guildId);

    // Handle task assignment as usual
    const assignedName = getAssignedName({ assigned: userId }, guildId);
    console.log(`Task assigned to: ${assignedName}`);
}
