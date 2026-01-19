/**
 * Task utilities and re-exports for backward compatibility
 */
const fs = require('fs');
const path = require('path');
const users = require('./users');

// Re-export from new modules for backward compatibility
const { ensureDirectoryExists, loadJsonFile, saveJsonFile, downloadFile, scrubEmptyFields, delay, logProgress } = require('./fileManager');
const { calculateAge, getYear, getMonthYear } = require('./dateUtils');
const { splitMessage, truncateString, cleanupTasks } = require('./messageUtils');
const { readLogEntries, appendLogEntry } = require('./csvUtils');

/**
 * Parse task IDs from command arguments
 * @param {string[]} args - Command arguments
 * @returns {number[]} Array of parsed task IDs
 */
function parseTaskIds(args) {
    return args
        .slice(1)
        .map(arg => parseInt(arg))
        .filter(id => !isNaN(id));
}

/**
 * Get tasks by their IDs
 * @param {number[]} taskIds - Task IDs to find
 * @param {Object} tasksData - Tasks data object
 * @returns {Object[]} Matching tasks
 */
function getTasksByIds(taskIds, tasksData) {
    return tasksData.tasks.filter(task => taskIds.includes(task.id));
}

/**
 * Get tasks by status
 * @param {string} status - Status to filter by
 * @param {Object} tasksData - Tasks data object
 * @returns {Object[]} Matching tasks
 * @throws {Error} If no matching tasks found
 */
function getTasksByStatus(status, tasksData) {
    const tasks = tasksData.tasks.filter((task) => status === task.status);
    if (tasks.length === 0) {
        throw new Error('No matching tasks found for the provided Status.');
    }
    return tasks;
}

/**
 * Update task status and optionally assign user
 * @param {Object} task - Task to update
 * @param {string} status - New status
 * @param {string} userId - User ID to assign (optional)
 * @returns {Object} Updated task
 */
function updateTaskStatus(task, status, userId = null) {
    if (userId && (!task.assigned || task.assigned.trim() === '')) {
        task.assigned = userId;
    }
    task.status = status;
    return task;
}

/**
 * Validate task IDs exist in tasks data
 * @param {number[]} taskIds - Task IDs to validate
 * @param {Object} tasksData - Tasks data object
 * @returns {number[]} Valid task IDs
 * @throws {Error} If no valid IDs found
 */
function validateTaskIds(taskIds, tasksData) {
    const validIds = taskIds.filter(id => tasksData.tasks.some(task => task.id === id));
    if (validIds.length === 0) {
        throw new Error('No valid task IDs provided.');
    }
    return validIds;
}

/**
 * Assign a task to a user
 * @param {Object} task - Task to assign
 * @param {string} userId - User ID to assign
 * @returns {Object} Updated task
 */
function assignTask(task, userId) {
    task.assigned = userId;
    task.status = 'Active';
    return task;
}

/**
 * Format tasks as a display string
 * @param {Object[]} tasks - Tasks to format
 * @returns {string} Formatted task list
 */
function formatTasks(tasks) {
    return tasks.map(task => `[${task.id}] ${task.name}`).join('\n');
}

/**
 * Save tasks data for a guild
 * @param {string} guildId - Guild ID
 * @param {Object} tasksData - Tasks data to save
 */
function saveTasks(guildId, tasksData) {
    const guildPath = users.getGuildPath(guildId);
    const tasksFile = path.join(guildPath, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));
}

module.exports = {
    // Task utilities
    parseTaskIds,
    getTasksByIds,
    getTasksByStatus,
    updateTaskStatus,
    validateTaskIds,
    assignTask,
    formatTasks,
    saveTasks,
    // Re-exports for backward compatibility
    ensureDirectoryExists,
    loadJsonFile,
    saveJsonFile,
    downloadFile,
    scrubEmptyFields,
    delay,
    logProgress,
    calculateAge,
    getYear,
    getMonthYear,
    splitMessage,
    truncateString,
    cleanupTasks,
    readLogEntries,
    appendLogEntry
};
