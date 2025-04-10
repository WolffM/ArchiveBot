const fs = require('fs');
const path = require('path');
const users = require('./users');
const csvParser = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const axios = require('axios');
const https = require('https');

function parseTaskIds(args) {
    return args
        .slice(1)
        .map(arg => parseInt(arg))
        .filter(id => !isNaN(id));
}

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

function truncateString (str, maxLength) {
    return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
};

function getTasksByIds(taskIds, tasksData) {
    return tasksData.tasks.filter(task => taskIds.includes(task.id));
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
    const validIds = taskIds.filter(id => tasksData.tasks.some(task => task.id === id));
    if (validIds.length === 0) {
        throw new Error('No valid task IDs provided.');
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
    return tasks.map(task => `[${task.id}] ${task.name}`).join('\n');
}

function calculateAge(dateString) {
    const created = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - created);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 1 ? `${diffDays}d` : '1d';
}

function processTaskNames(args, tasksData, guildId, user) {
    const addedTasks = [];
    const skippedTasks = [];
    // Extract the task name(s) from args as needed.
    const taskName = args[0]; // Simplest case (you may have additional parsing logic)
  
    // Check for duplicate tasks, and then create a new task if there isn't one.
    const isDuplicate = tasksData.tasks.some(task => task.taskName === taskName);
    if (isDuplicate) {
      skippedTasks.push(taskName);
    } else {
      const newTask = {
        taskId: tasksData.currentTaskId,
        taskName,
        date: new Date().toISOString(),
        status: 'New',
        assigned: '',  // remains empty until explicitly assigned
        author: { id: user.id, username: user.username }
      };
      tasksData.tasks.push(newTask);
      tasksData.currentTaskId++;
      addedTasks.push(newTask);
    }
  
    // Save tasksData (assuming saveTasks is implemented to handle that)
    saveTasks(guildId, tasksData);
  
    return { addedTasks, skippedTasks };
  }

function saveTasks(guildId, tasksData) {
    const guildPath = users.getGuildPath(guildId);
    const tasksFile = path.join(guildPath, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));
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

/**
 * Build a GitHub-like weekly contribution graph for completed tasks in the last 32 weeks.
 * Aggregates tasks by week and arranges them in a grid with 4 rows and 8 columns (32 weeks total).
 * Uses a weather-themed gradient of standard Unicode emojis:
 *   0 tasks      => ☁️
 *   ratio <=0.25 => 🌥
 *   ratio <=0.5  => ⛅️
 *   ratio <=0.75 => 🌤
 *   ratio >0.75  => ☀️
 *
 * This version returns an array of message strings that you can send separately.
 */
function buildWeeklyContributionGraph(tasksData, guildId) {
    const now = new Date();
    const totalWeeks = 32;
    const ms32Weeks = totalWeeks * 7 * 24 * 60 * 60 * 1000;
    const startDate = new Date(now.getTime() - ms32Weeks);
    
    // Build per-user weekly aggregates: userId -> array of weekly counts (32 weeks)
    const userWeeklyCounts = {};
    
    tasksData.tasks.forEach(task => {
      if (task && task.status === 'Completed' && task.assigned) {
        // Use completedDate if available; otherwise fallback to createdDate.
        const dateStr = task.completedDate ? task.completedDate : task.createdDate;
        if (!dateStr) {
          console.log(`Task ${task.id} has no valid date.`);
          return;
        }
        const dateToUse = new Date(dateStr);
        if (dateToUse >= startDate && dateToUse <= now) {
          const weekIndex = Math.floor((dateToUse - startDate) / (7 * 24 * 60 * 60 * 1000));
          if (weekIndex < totalWeeks) {
            const userId = task.assigned;
            if (!userWeeklyCounts[userId]) {
              // Initialize an array for 32 weeks with 0's
              userWeeklyCounts[userId] = new Array(totalWeeks).fill(0);
            }
            userWeeklyCounts[userId][weekIndex]++;
          }
        }
      }
    });
    
    // Build an array of message strings.
    const messages = [];
    messages.push("**Completed Tasks Weekly Contribution Graph (Last 32 Weeks)**");
    
    // Mapping function: returns a weather-themed emoji based on count ratio.
    const getWeatherEmoji = (count, maxCount) => {
      if (count === 0) return ':cloud:';
      const ratio = count / (maxCount || 1);
      if (ratio <= 0.25) return ':white_sun_cloud:';
      else if (ratio <= 0.5) return ':partly_sunny:';
      else if (ratio <= 0.75) return ':white_sun_small_cloud:';
      else return ':sunny:';
    };
    
    // For each user, build and add their graph.
    for (const userId in userWeeklyCounts) {
      const weeklyCounts = userWeeklyCounts[userId];
      const displayName = users.getDisplayName(userId, guildId);
      messages.push(`**${displayName}**`);
    
      // Determine the maximum count (for scaling the gradient)
      const maxCount = Math.max(...weeklyCounts);
    
      // Arrange weekly counts into a grid with 4 rows and 8 columns.
      const numRows = 4;
      const numColumns = totalWeeks / numRows; // 32 / 4 = 8
      const grid = [];
      for (let r = 0; r < numRows; r++) {
        grid[r] = [];
        for (let c = 0; c < numColumns; c++) {
          // Column-major filling: index = (column index * numRows) + row index.
          const idx = c * numRows + r;
          const count = idx < weeklyCounts.length ? weeklyCounts[idx] : 0;
          grid[r].push(getWeatherEmoji(count, maxCount));
        }
      }
      
      // Add each row as a separate message.
      for (let r = 0; r < numRows; r++) {
        messages.push(grid[r].join(' '));
      }
    }
    
    console.log("Final Messages Array:", messages);
    return messages;
  }
  

module.exports = { buildWeeklyContributionGraph, getYear, getMonthYear, readLogEntries, appendLogEntry, ensureDirectoryExists, cleanupTasks, truncateString, saveTasks, processTaskNames, calculateAge, formatTasks, logTaskAction, assignTask, splitMessage, validateTaskIds, getTasksByStatus, updateTaskStatus, getTasksByIds, parseTaskIds, loadJsonFile, saveJsonFile, downloadFile, scrubEmptyFields, delay, logProgress }; 