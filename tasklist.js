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

    // Helper function to truncate string dynamically
    const truncateString = (str, maxLength) => {
        return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
    };

    // Helper function to create table
    const createTable = (title, tasks, headers, columnSelectors) => {
        const maxRowWidth = 50;
        const separatorWidth = headers.length - 1; // Account for separators

        const maxLengths = headers.reduce((lengths, header, index) => {
            lengths[index] = Math.max(
                header.length,
                ...tasks.map((task) => columnSelectors[index](task).length)
            );
            return lengths;
        }, []);

        const totalFixedWidth = maxLengths.reduce((sum, length) => sum + length, 0) + separatorWidth;

        // Dynamically adjust the task name column if the total width exceeds the max
        if (totalFixedWidth > maxRowWidth) {
            const taskNameIndex = headers.indexOf("Task Name");
            const excessWidth = totalFixedWidth - maxRowWidth;
            maxLengths[taskNameIndex] -= excessWidth;
        }

        const headerRow = `| ${headers.map((h, i) => h.padEnd(maxLengths[i])).join(' | ')} |`;
        const separatorRow = `|-${maxLengths.map((len) => '-'.repeat(len)).join('-|-')}-|`;

        const taskRows = tasks.map((task) => {
            const row = columnSelectors.map((selector, i) => {
                const columnData = selector(task);
                return truncateString(columnData, maxLengths[i]).padEnd(maxLengths[i]);
            });

            return `| ${row.join(' | ')} |`;
        });

        return taskRows.length > 0
            ? [headerRow, separatorRow, ...taskRows].join('\n')
            : "No tasks available.";
    };

    // Define New Tasks Table
    const newTasks = tasksData.tasks.filter((task) => task.status === 'New');
    const newTaskHeaders = ["ID", "Task Name", "Age"];
    const newTaskSelectors = [
        (task) => task.taskId.toString(),
        (task) => task.taskName,
        (task) => helper.calculateAge(task.date),
    ];
    const newTaskDisplay = createTable("New Tasks", newTasks, newTaskHeaders, newTaskSelectors);

    // Define Active Tasks Table
    const activeTasks = tasksData.tasks.filter((task) => task.status === 'Active');
    const activeTaskHeaders = ["ID", "Task Name", "Age", "Assigned"];
    const activeTaskSelectors = [
        (task) => task.taskId.toString(),
        (task) => task.taskName,
        (task) => helper.calculateAge(task.date),
        (task) => task.assigned ? users.getDisplayName(task.assigned, guildId) : "Unassigned",
    ];
    const activeTaskDisplay = createTable("Active Tasks", activeTasks, activeTaskHeaders, activeTaskSelectors);

    // Define Completed Tasks Table
    const guildPath = users.getGuildPath(guildId);
    const statsFile = path.join(guildPath, 'stats.csv');
    const completedTasks = fs.readFileSync(statsFile, 'utf8')
        .split('\n')
        .slice(1) // Skip header row
        .filter((line) => {
            if (!line.trim()) return false;
            const parts = line.split(',');
            if (parts[5] !== 'Completed') return false;

            const completedDate = new Date(parts[4]);
            const now = new Date();
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(now.getDate() - 30);

            return completedDate >= thirtyDaysAgo;
        })
        .map((line) => {
            const [userId, taskId, taskName, createdDate, completedDate] = line.split(',');
            return {
                userName: users.getDisplayName(userId.trim(), guildId),
                taskId: taskId.toString(),
                taskName: taskName.trim(),
                age: helper.calculateAge(new Date(createdDate)),
                completedDate: new Date(completedDate.trim()).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                }),
            };
        });

    const completedTaskHeaders = ["ID", "Task Name", "Date", "Assigned"];
    const completedTaskSelectors = [
        (task) => task.taskId,
        (task) => task.taskName,
        (task) => task.completedDate,
        (task) => task.userName,
    ];
    const completedTaskDisplay = createTable("Completed Tasks", completedTasks, completedTaskHeaders, completedTaskSelectors);

    // Helper to send task messages
    const sendTaskMessages = async (title, taskDisplay) => {
        const chunks = helper.splitMessage(taskDisplay);
        for (let i = 0; i < chunks.length; i++) {
            const content = i === 0 ? `**${title}**\n\`\`\`\n${chunks[i]}\n\`\`\`` : `\`\`\`\n${chunks[i]}\n\`\`\``;
            await message.channel.send(content);
        }
    };

    // Clean up recent messages
    const commandsToDelete = ["!add", "!done", "!clear", "!take", "!init", "!helpt", "!testt"];
    const messages = await message.channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter((msg) => msg.author.id === message.client.user.id);
    const userMessages = messages.filter((msg) => msg.author.id === message.author.id);
    const botMessagesToDelete = Array.from(botMessages.values()).slice(1);
    const userCommandMessages = Array.from(userMessages.values()).filter((msg) =>
        commandsToDelete.some((cmd) => msg.content.trim().toLowerCase().startsWith(cmd))
    ).slice(1);
    await Promise.all([...botMessagesToDelete, ...userCommandMessages].map((msg) => msg.delete()));

    // Send the task lists
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
        const helpMessage = helper.postHelp(message);
        try {
            await message.author.send(helpMessage);
            await message.channel.send(`${message.author}, I have sent you a DM with the command list and examples.`);
        } catch (error) {
            console.error("Failed to send help message via DM:", error);
            await message.channel.send(`${message.author}, I couldn't send you a DM. Please check your privacy settings.`);
        }
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
            try {
                const { addedTasks, skippedTasks } = await helper.processTaskNames(args.slice(1), tasksData, guildId);
                const addedMessage = addedTasks.length > 0 ? `Tasks added:\n${helper.formatTasks(addedTasks)}` : "No new tasks added.";
                const skippedMessage = skippedTasks.length > 0 ? `Skipped duplicates:\n${skippedTasks.join(', ')}` : "";
    
                await message.channel.send(`${addedMessage}${skippedMessage ? `\n${skippedMessage}` : ""}`);
            } catch (error) {
                await message.channel.send(error.message);
            }
            break;
        }       

        case 'done': {
            try {
                if (args.join(' ').includes('"')) {
                    // Handle quoted task names
                    const { addedTasks, skippedTasks } = await helper.processTaskNames(args.slice(1), tasksData, guildId);
        
                    // Immediately mark added tasks as completed
                    addedTasks.forEach((task) => helper.updateTaskStatus(task, 'Completed', message.author.id));
                    helper.logTaskAction(addedTasks, guildId, message.author.id, 'Completed', logStat);
        
                    // Save updated tasksData
                    saveTasks(guildId, tasksData);
        
                    const addedMessage = addedTasks.length > 0 ? `Tasks marked as completed:\n${helper.formatTasks(addedTasks)}` : "No new tasks completed.";
                    const skippedMessage = skippedTasks.length > 0 ? `Skipped duplicates:\n${skippedTasks.join(', ')}` : "";
        
                    await message.channel.send(`${addedMessage}${skippedMessage ? `\n${skippedMessage}` : ""}`);
                } else {
                    // Handle numeric task IDs
                    const taskIds = helper.parseTaskIds(args);
                    const validIds = helper.validateTaskIds(taskIds, tasksData);
                    const tasks = helper.getTasksByIds(validIds, tasksData);
        
                    tasks.forEach((task) => helper.updateTaskStatus(task, 'Completed', message.author.id));
                    helper.logTaskAction(tasks, guildId, message.author.id, 'Completed', logStat);
        
                    // Save updated tasksData
                    saveTasks(guildId, tasksData);
        
                    const formattedTasks = helper.formatTasks(tasks);
                    await message.channel.send(`Tasks marked as completed:\n${formattedTasks}`);
                }
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
                helper.saveTasks(guildId, tasksData);
        
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
                helper.saveTasks(guildId, tasksData);
        
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
    await helper.cleanupTasks(guildId, tasksData);
    await displayTaskList(message, guildId);
}

module.exports = { start };