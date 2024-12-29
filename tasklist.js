const fs = require('fs');
const path = require('path');
const users = require('./users');
const helper = require('./helper');

function loadTasks(guildId) {
    const guildPath = users.getGuildPath(guildId);
    helper.ensureDirectoryExists(guildPath);
    const filePath = path.join(guildPath, 'tasks.json');
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath));
    } else {
        const initialData = { currentTaskId: 1, tasks: [] };
        fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2));
        return initialData;
    }
}

function saveTasks(guildId, data) {
    const guildPath = users.getGuildPath(guildId);
    const filePath = path.join(guildPath, 'tasks.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function logStat(guildId, userId, taskId, taskName, status, createdDate = null) {
    const guildPath = users.getGuildPath(guildId);
    const statsFile = path.join(guildPath, 'stats.csv');

    // If no createdDate is provided, set it to the current time
    const now = new Date().toISOString();
    createdDate = createdDate || now;

    // Log the stat with both dates
    const logLine = `${userId},${taskId},${taskName},${createdDate},${now},${status}\n`;
    fs.appendFileSync(statsFile, logLine);
}

async function initialize(message, guildId) {
    const guildPath = users.getGuildPath(guildId);
    helper.ensureDirectoryExists(guildPath); // Use helper

    const usersFilePath = path.join(guildPath, 'users.json');
    const tasksFilePath = path.join(guildPath, 'tasks.json');
    const statsFilePath = path.join(guildPath, 'stats.csv');

    // Remove existing tasks and stats files
    [tasksFilePath, statsFilePath].forEach((file) => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    });

    // Initialize files
    const initialData = { currentTaskId: 1, tasks: [] };
    fs.writeFileSync(tasksFilePath, JSON.stringify(initialData, null, 2));
    fs.writeFileSync(statsFilePath, 'userId,taskId,taskName,date,status\n');

    if (!fs.existsSync(usersFilePath)) {
        fs.writeFileSync(usersFilePath, JSON.stringify({}, null, 2));
    }

    await message.channel.send('Tasklist initialized successfully!');
}


async function displayTaskList(message, guildId) {
    const tasksData = loadTasks(guildId);

    // Separate tasks into New and Active
    const newTasks = tasksData.tasks.filter((task) => task.status === 'New');
    const activeTasks = tasksData.tasks.filter((task) => task.status === 'Active');

    // Define headers
    const headers = ["ID", "Task Name", "Status", "Age", "Assigned"];

    // Calculate max lengths for columns
    const calculateMaxLengths = (tasks, includeAssigned = false) => ({
        id: Math.max(headers[0].length, ...tasks.map(task => task.taskId.toString().length)),
        name: Math.max(headers[1].length, ...tasks.map(task => task.taskName.length)),
        status: Math.max(headers[2].length, ...tasks.map(task => task.status.length)),
        age: Math.max(headers[3].length, ...tasks.map(task => helper.calculateAge(task.date).length)),
        ...(includeAssigned && {
            assigned: Math.max(headers[4].length, ...tasks.map(task => {
                const assigned = task.assigned ? users.getDisplayName(task.assigned, guildId) : "Unassigned";
                return assigned.length;
            }))
        })
    });

    const maxNewLengths = calculateMaxLengths(newTasks);
    const maxActiveLengths = calculateMaxLengths(activeTasks, true);

    // Generate headers and separators
    const generateHeader = (lengths, includeAssigned = false) => {
        const header = `| ${headers[0].padEnd(lengths.id)} | ${headers[1].padEnd(lengths.name)} | ${headers[2].padEnd(lengths.status)} | ${headers[3].padEnd(lengths.age)} |`;
        const separator = `|-${'-'.repeat(lengths.id)}-|-${'-'.repeat(lengths.name)}-|-${'-'.repeat(lengths.status)}-|-${'-'.repeat(lengths.age)}-|`;
        if (includeAssigned) {
            return {
                header: `${header} ${headers[4].padEnd(lengths.assigned)} |`,
                separator: `${separator}-${'-'.repeat(lengths.assigned)}-|`
            };
        }
        return { header, separator };
    };

    const newHeaderData = generateHeader(maxNewLengths);
    const activeHeaderData = generateHeader(maxActiveLengths, true);

    const generateTaskRows = (tasks, lengths, includeAssigned = false) => {
        return tasks.map((task) => {
            const age = helper.calculateAge(task.date); // Use helper here
            const assigned = includeAssigned ? (task.assigned ? users.getDisplayName(task.assigned, guildId) : "Unassigned") : "";
            return `| ${task.taskId.toString().padEnd(lengths.id)} | ${task.taskName.padEnd(lengths.name)} | ${task.status.padEnd(lengths.status)} | ${age.padEnd(lengths.age)} |${includeAssigned ? ` ${assigned.padEnd(lengths.assigned)} |` : ""}`;
        });
    };

    const newTaskRows = generateTaskRows(newTasks, maxNewLengths);
    const activeTaskRows = generateTaskRows(activeTasks, maxActiveLengths, true);

    // Combine headers, separators, and rows into strings
    const combineTable = (header, separator, rows) => {
        if (rows.length === 0) return "No tasks available.";
        return [header, separator, ...rows].join('\n');
    };

    const newTaskDisplay = combineTable(newHeaderData.header, newHeaderData.separator, newTaskRows);
    const activeTaskDisplay = combineTable(activeHeaderData.header, activeHeaderData.separator, activeTaskRows);

    // Add logic for Completed Tasks
    const guildPath = users.getGuildPath(guildId);
    const statsFile = path.join(guildPath, 'stats.csv');
    const completedTasks = fs.readFileSync(statsFile, 'utf8')
    .split('\n')
    .slice(1) // Skip header row
    .filter(line => {
        if (!line.trim()) return false; // Skip empty lines
        const parts = line.split(',');
        if (parts[5] !== 'Completed') return false; // Skip non-completed tasks
        
        const completedDate = new Date(parts[4]); // Use the 5th column for the completed date
        const now = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);

        return completedDate >= thirtyDaysAgo; // Include only tasks within the last 30 days
    })
    .map(line => {
        const [userId, taskId, taskName, createdDate, completedDate] = line.split(',');
        const age = helper.calculateAge(new Date(createdDate));

        // Format completedDate to "MMM DD"
        const formattedCompletedDate = new Date(completedDate.trim()).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        });

        return {
            userName: users.getDisplayName(userId.trim(), guildId),
            taskName: taskName.trim(),
            age,
            completedDate: formattedCompletedDate
        };
    });

    const completedHeaders = ["User Name", "Task Name", "Age", "Completed Date (Last 30 days)"];
    const maxCompletedLengths = {
        userName: Math.max(completedHeaders[0].length, ...completedTasks.map(task => task.userName.length)),
        taskName: Math.max(completedHeaders[1].length, ...completedTasks.map(task => task.taskName.length)),
        age: Math.max(completedHeaders[2].length, ...completedTasks.map(task => task.age.length)),
        completedDate: Math.max(completedHeaders[3].length, ...completedTasks.map(task => task.completedDate.length))
    };

    const completedHeader = `| ${completedHeaders[0].padEnd(maxCompletedLengths.userName)} | ${completedHeaders[1].padEnd(maxCompletedLengths.taskName)} | ${completedHeaders[2].padEnd(maxCompletedLengths.age)} | ${completedHeaders[3].padEnd(maxCompletedLengths.completedDate)} |`;
    const completedSeparator = `|-${'-'.repeat(maxCompletedLengths.userName)}-|-${'-'.repeat(maxCompletedLengths.taskName)}-|-${'-'.repeat(maxCompletedLengths.age)}-|-${'-'.repeat(maxCompletedLengths.completedDate)}-|`;
    const completedRows = completedTasks.map(task => {
        return `| ${task.userName.padEnd(maxCompletedLengths.userName)} | ${task.taskName.padEnd(maxCompletedLengths.taskName)} | ${task.age.padEnd(maxCompletedLengths.age)} | ${task.completedDate.padEnd(maxCompletedLengths.completedDate)} |`;
    });

    const completedTaskDisplay = completedRows.length > 0
        ? [completedHeader, completedSeparator, ...completedRows].join('\n')
        : "No completed tasks.";

    const sendTaskMessages = async (title, taskDisplay) => {
        const chunks = helper.splitMessage(taskDisplay);
        for (let i = 0; i < chunks.length; i++) {
            const content = i === 0 ? `**${title}**\n\`\`\`\n${chunks[i]}\n\`\`\`` : `\`\`\`\n${chunks[i]}\n\`\`\``;
            await message.channel.send(content);
        }
    };

    // The commands to look for
    const commandsToDelete = ["!add", "!done", "!clear", "!take", "!init", "!helpt", "!testt"];

    // Fetch the recent messages
    const messages = await message.channel.messages.fetch({ limit: 50 });

    // Separate out bot and user messages
    const botMessages = messages.filter((msg) => msg.author.id === message.client.user.id);
    const userMessages = messages.filter((msg) => msg.author.id === message.author.id);

    // Delete (all but the most recent) bot messages
    const botMessagesToDelete = Array.from(botMessages.values()).slice(1);
    await Promise.all(botMessagesToDelete.map((msg) => msg.delete()));

    // Filter user messages that *start with* the listed commands, then slice(1)
    const userCommandMessages = Array.from(userMessages.values()).filter((msg) =>
    commandsToDelete.some((cmd) => msg.content.trim().toLowerCase().startsWith(cmd))
    );

    // We slice(1) so the newest message that triggered this doesn't get deleted
    const userMessagesToDelete = userCommandMessages.slice(1);
    await Promise.all(userMessagesToDelete.map((msg) => msg.delete()));

    // Send New, Active, and Completed task lists
    await sendTaskMessages("New Tasks", newTaskDisplay);
    await sendTaskMessages("Active Tasks", activeTaskDisplay);
    await sendTaskMessages("Completed Tasks", completedTaskDisplay);
}


async function start(message, args, adminUserIds) {
    const guildId = message.guild.id;

    // Handle the init command before checking for existing data
    const command = args[0];
    if (command === 'init') {
        if (!adminUserIds.includes(message.author.id)) {
            await message.channel.send("Insufficient permission, please contact an admin.");
            return;
        }
        await initialize(message, guildId);
        return;
    }

    users.handleNewMessage(message);
    if (command === 'helpt') {
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
    try {
        await message.author.send(helpMessage);
        await message.channel.send(`${message.author}, I have sent you a DM with the command list and examples.`);
    } catch (error) {
        console.error("Failed to send help message via DM:", error);
        await message.channel.send(`${message.author}, I couldn't send you a DM. Please check your privacy settings.`);
    }
        return;
    }

    // Ensure the guild is initialized
    const guildPath = users.getGuildPath(guildId);
    if (!fs.existsSync(guildPath)) {
        message.channel.send("Init first please!");
        return;
    }

    const tasksData = loadTasks(guildId);

    switch (command) {
        case 'add': {
            const quotedTaskNames = args.slice(1).join(' ').match(/"([^"]+)"/g)?.map((name) => name.replace(/"/g, '').trim());
            const addedTasks = [];
            const skippedTasks = [];
        
            (quotedTaskNames || [args.slice(1).join(' ').trim()]).forEach((taskName) => {
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
        
            const addedMessage = addedTasks.length > 0 ? `Tasks added:\n${helper.formatTasks(addedTasks)}` : "No new tasks added.";
            const skippedMessage = skippedTasks.length > 0 ? `Skipped duplicates:\n${skippedTasks.join(', ')}` : "";
        
            await message.channel.send(`${addedMessage}${skippedMessage ? `\n${skippedMessage}` : ""}`);
            break;
        }        

        case 'done': {
            try {
                const taskIds = helper.parseTaskIds(args);
                const validIds = helper.validateTaskIds(taskIds, tasksData);
                const tasks = helper.getTasksByIds(validIds, tasksData);
        
                tasks.forEach((task) => helper.updateTaskStatus(task, 'Completed', message.author.id));
                helper.logTaskAction(tasks, guildId, message.author.id, 'Completed', logStat);
                saveTasks(guildId, tasksData);
        
                const formattedTasks = helper.formatTasks(tasks);
                await message.channel.send(`Tasks marked as completed:\n${formattedTasks}`);
            } catch (error) {
                await message.channel.send(error.message);
            }
            break;
        }

        case 'delete': {
            try {
                const taskIds = helper.parseTaskIds(args);
                const validIds = helper.validateTaskIds(taskIds, tasksData);
        
                const initialCount = tasksData.tasks.length;
                const deletedTasks = helper.getTasksByIds(validIds, tasksData);
                helper.logTaskAction(deletedTasks, guildId, message.author.id, 'Abandoned', logStat);
                tasksData.tasks = tasksData.tasks.filter((task) => !validIds.includes(task.taskId));
                saveTasks(guildId, tasksData);
        
                const deletedCount = initialCount - tasksData.tasks.length;
                await message.channel.send(`Deleted ${deletedCount} task(s).`);
            } catch (error) {
                await message.channel.send(error.message);
            }
            break;
        }

        case 'take': {
            try {
                const taskIds = helper.parseTaskIds(args);
                const validIds = helper.validateTaskIds(taskIds, tasksData);
                const tasks = helper.getTasksByIds(validIds, tasksData);
        
                tasks.forEach((task) => helper.assignTask(task, message.author.id));
                saveTasks(guildId, tasksData);
        
                const formattedTasks = helper.formatTasks(tasks);
                await message.channel.send(`Tasks taken by you:\n${formattedTasks}`);
            } catch (error) {
                await message.channel.send(error.message);
            }
            break;
        }
        
        case 'testt':
            await message.channel.send(`Refreshing.`);
            break;
        
        default:
        await message.channel.send(`Unknown task command: ${command}`);
        break;
    }

    // Refresh and display the task list
    await displayTaskList(message, guildId);
}

module.exports = { start };