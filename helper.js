const fs = require('fs');
const path = require('path');
const users = require('./users');
const csvParser = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const axios = require('axios');
const https = require('https');

function parseTaskIds(args) {
    const rawInput = args.slice(1).join(' ').trim(); // Join everything after the command
    let ids = [];

    try {
        // Remove surrounding quotes or brackets if they exist
        const cleanedInput = rawInput.replace(/^[\[\("\']|[\]\)"\']$/g, '');
        // Split by commas and parse integers
        ids = cleanedInput.split(',').map((id) => parseInt(id.trim())).filter((id) => !isNaN(id));
    } catch (error) {
        throw new Error('Invalid task ID format. Please provide a list of task IDs.');
    }

    if (ids.length === 0) {
        throw new Error('No valid task IDs found.');
    }

    return ids;
}

async function cleanupTasks(guildId, tasksData) {
    const stats = []; // Initialize the stats array
    const guildPath = users.getGuildPath(guildId);
    const statsFile = path.join(guildPath, 'stats.csv');
    const tasksFilePath = path.join(guildPath, 'tasks.json'); // Define tasks.json file path

    // Wrap CSV loading in a promise
    await new Promise((resolve, reject) => {
        fs.createReadStream(statsFile)
            .pipe(csvParser())
            .on('data', (row) => {
                stats.push({
                    assigned: row['assigned'],
                    taskId: parseInt(row['taskId'], 10),
                    taskName: row['taskName'],
                    status: row['status'],
                });
            })
            .on('end', () => {
                console.log('Stats loaded successfully.');
                resolve();
            })
            .on('error', (err) => {
                console.error('Error reading stats.csv:', err);
                reject(err);
            });
    });

    // Sync tasks.json with stats.csv
    tasksData.tasks.forEach((task) => {
        const statEntry = stats.find((stat) => stat.taskId === task.taskId);

        if (statEntry) {
            // Update task data from stats.csv
            if (task.assigned !== statEntry.assigned) {
                task.assigned = statEntry.assigned;
            }
            if (task.status !== statEntry.status) {
                task.status = statEntry.status;
            }
        } else if (!task.assigned && task.status !== 'New') {
            // Handle unassigned tasks
            console.log(`Task ${task.taskId}: "${task.taskName}" is missing an assigned user.`);
        }
    });

    // Save the updated tasks.json
    try {
        fs.writeFileSync(tasksFilePath, JSON.stringify(tasksData, null, 4), 'utf8');
        console.log('Tasks cleaned and saved successfully.');
    } catch (err) {
        console.error('Error writing tasks.json:', err);
    }
}

function truncateString (str, maxLength) {
    return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
};

function getTasksByIds(taskIds, tasksData) {
    const tasks = tasksData.tasks.filter((task) => taskIds.includes(task.taskId));
    if (tasks.length === 0) {
        throw new Error('No matching tasks found for the provided IDs.');
    }
    return tasks;
}

function getTasksByStatus(status, tasksData) {
    const tasks = tasksData.tasks.filter((task) => status === task.status);
    if (tasks.length === 0) {
        throw new Error('No matching tasks found for the provided Status.');
    }
    return tasks;
}

function updateTaskStatus(task, status, userId = null) {
    if (userId && (!task.assigned || task.assigned.trim() === '')) {
        task.assigned = userId; // Assign if unassigned
    }
    task.status = status;
    return task;
}

function readLogEntries(logFilePath) {
    if (!fs.existsSync(logFilePath)) {
        return []; // No log file yet
    }

    const logRaw = fs.readFileSync(logFilePath, 'utf8');
    // We can do a quick manual parse if we prefer:
    // Or we can do a streaming parse. 
    // For simplicity, let's do a synchronous parse with csv-parser or csv-parse.

    const lines = logRaw.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return []; // Only headers or empty

    const headers = lines[0].split(',').map(h => h.trim());
    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < 4) continue; // skip incomplete lines
        const record = {};
        headers.forEach((header, index) => {
            record[header] = row[index];
        });
        records.push(record);
    }
    return records;
}

async function appendLogEntry(logFilePath, newEntry) {
    const csvWriterInstance = createObjectCsvWriter({
        path: logFilePath,
        append: true,
        header: [
            { id: 'Task', title: 'Task' },
            { id: 'Guild Name', title: 'Guild Name' },
            { id: 'Channel ID', title: 'Channel ID' },
            { id: 'Timestamp', title: 'Timestamp' },
        ],
    });
    await csvWriterInstance.writeRecords([newEntry]);
}

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function validateTaskIds(taskIds, tasksData) {
    const validIds = taskIds.filter((id) => tasksData.tasks.some((task) => task.taskId === id));
    if (validIds.length === 0) {
        throw new Error('None of the provided task IDs are valid.');
    }
    return validIds;
}

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

function assignTask(task, userId) {
    task.assigned = userId;
    task.status = 'Active';
    return task;
}

function logTaskAction(tasks, guildId, userId, action, logStat) {
    tasks.forEach((task) => {
        logStat(guildId, userId, task.taskId, task.taskName, action);
    });
}

function formatTasks(tasks) {
    return tasks.map((task) => `[${task.taskId}] ${task.taskName}`).join('\n');
}

function calculateAge(creationDate) {
    const now = new Date();
    const created = new Date(creationDate);
    const diffSeconds = Math.floor((now - created) / 1000);

    if (diffSeconds < 10) return 'Fresh!';
    if (diffSeconds < 60) return `${diffSeconds} sec`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} min`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
    const diffDays = Math.floor(diffMinutes / 1440);
    return `${diffDays} day${diffDays > 1 ? 's' : ''}`;
}

async function processTaskNames(args, tasksData, guildId) {
    const quotedTaskNames = args.join(' ').match(/"([^"]+)"/g)?.map((name) => name.replace(/"/g, '').trim());
    const addedTasks = [];
    const skippedTasks = [];

    (quotedTaskNames || [args.join(' ').trim()]).forEach((taskName) => {
        if (!taskName) return;

        const isDuplicate = tasksData.tasks.some((task) => task.taskName === taskName);
        if (isDuplicate) {
            skippedTasks.push(taskName);
        } else {
            const newTask = {
                taskId: tasksData.currentTaskId,
                taskName,
                date: new Date().toISOString(),
                status: 'New',
                assigned: '',
            };
            tasksData.tasks.push(newTask);
            tasksData.currentTaskId++;
            addedTasks.push(newTask);
        }
    });

    saveTasks(guildId, tasksData);

    return { addedTasks, skippedTasks };
}

function saveTasks(guildId, data) {
    const guildPath = users.getGuildPath(guildId);
    const filePath = path.join(guildPath, 'tasks.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function postHelp() {
        const helpMessage = `
        **Task Bot Commands**
        
        **1. !add**
        * Add one or more tasks to the list.
          Example (single): \`!add clean dishes\`
          Example (multiple): \`!add "clean dishes", "do laundry", "meditate"\`
        
        **2. !done**
        * Mark a task as completed.
          Example: \`!done 2\`
        
        **3. !clear**
        * Remove all completed tasks from the list.
          Example: \`!clear\`
        
        **4. !delete**
        * Permanently delete a task and log it as abandoned.
          Example: \`!delete 3\`
        
        **5. !take**
        * Take responsibility for one or more tasks (mark as active).
          Example (single): \`!take 4\`
          Example (multiple): \`!take 4,5,6\`
        
        **6. !init**
        * Initialize the task list for the server (Admin only).
          Example: \`!init\`
        
        **7. !helpt**
        * Show this help message.
          Example: \`!helpt\`
        `;
        return helpMessage;
}

// Helper to get just the Year
function getYear(ts) {
    return new Date(ts).getUTCFullYear().toString();
}

function getMonthYear(ts) {
    const d = new Date(ts);
    // e.g. "2025-01" or "01-2025"
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function loadJsonFile(filePath, defaultValue = {}) {
    return fs.existsSync(filePath) ? 
        JSON.parse(fs.readFileSync(filePath)) : 
        defaultValue;
}

function saveJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(url, response => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', err => {
            fs.unlink(filePath, () => reject(err));
        });
    });
}

function scrubEmptyFields(obj, seen = new WeakSet()) {
    if (obj && typeof obj === 'object') {
        if (seen.has(obj)) return undefined;
        seen.add(obj);
        const scrubbed = {};
        for (const key in obj) {
            const value = scrubEmptyFields(obj[key], seen);
            if (value !== undefined && 
                value !== null && 
                !(key === 'discriminator' || 
                  key === 'avatar' || 
                  key === 'avatarDecorationData' || 
                  key === 'guildId' || 
                  key === 'channelId' || 
                  key === 'thumbnail' || 
                  key === 'video' || 
                  (key === 'flags' && value.bitfield === 0) || 
                  (key === 'type' && value === 0) || 
                  (key === 'position' && value === 0) || 
                  value === false)) {
                scrubbed[key] = value;
            }
        }
        return Object.keys(scrubbed).length > 0 ? scrubbed : undefined;
    } else if (Array.isArray(obj)) {
        return obj.length > 0 ? 
            obj.map(item => scrubEmptyFields(item, seen))
               .filter(item => item !== undefined) : 
            undefined;
    }
    return obj;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logProgress(label, current, total, interval = 50) {
    if (current % interval === 0) {
        console.log(`[${label}] ${current} processed, ${total} total.`);
    }
}

module.exports = { getYear, getMonthYear, readLogEntries, appendLogEntry, ensureDirectoryExists, cleanupTasks, truncateString, saveTasks, processTaskNames, postHelp, calculateAge, formatTasks, logTaskAction, assignTask, splitMessage, validateTaskIds, getTasksByStatus, updateTaskStatus, getTasksByIds, parseTaskIds, loadJsonFile, saveJsonFile, downloadFile, scrubEmptyFields, delay, logProgress }; 