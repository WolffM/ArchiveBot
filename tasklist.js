const fs = require('fs');
const path = require('path');
const users = require('./users');

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function loadTasks(guildId) {
    const guildPath = users.getGuildPath(guildId);
    ensureDirectoryExists(guildPath);
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

async function initialize(message, guildId) {
    const guildPath = users.getGuildPath(guildId);
    ensureDirectoryExists(guildPath);

    const usersFilePath = path.join(guildPath, 'users.json');
    const tasksFilePath = path.join(guildPath, 'tasks.json');
    const statsFilePath = path.join(guildPath, 'stats.csv');

    // Remove existing tasks and stats files
    if (fs.existsSync(tasksFilePath)) {
        fs.unlinkSync(tasksFilePath);
    }
    if (fs.existsSync(statsFilePath)) {
        fs.unlinkSync(statsFilePath);
    }

    // Initialize tasks and stats files
    const initialData = { currentTaskId: 1, tasks: [] };
    fs.writeFileSync(tasksFilePath, JSON.stringify(initialData, null, 2));
    fs.writeFileSync(statsFilePath, 'userId,taskId,taskName,date,status\n');

    // Initialize users file if it doesn't exist
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
        age: Math.max(headers[3].length, ...tasks.map(task => calculateAge(task.date).length)),
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

    // Generate task rows
    const generateTaskRows = (tasks, lengths, includeAssigned = false) => {
        return tasks.map((task) => {
            const age = calculateAge(task.date);
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
        const age = calculateAge(new Date(createdDate));

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

    // Helper function to split messages into chunks
    const splitMessage = (text, limit = 2000) => {
        const chunks = [];
        let currentChunk = "";
        for (const line of text.split('\n')) {
            if ((currentChunk + line).length + 1 > limit) {
                chunks.push(currentChunk);
                currentChunk = "";
            }
            currentChunk += `${line}\n`;
        }
        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    };

    // Split and send messages
    const sendTaskMessages = async (title, taskDisplay) => {
        const chunks = splitMessage(taskDisplay);
        for (let i = 0; i < chunks.length; i++) {
            const content = i === 0 ? `**${title}**\n\`\`\`\n${chunks[i]}\n\`\`\`` : `\`\`\`\n${chunks[i]}\n\`\`\``;
            await message.channel.send(content);
        }
    };

    // Delete older messages as before
    const messages = await message.channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter((msg) => msg.author.id === message.client.user.id);
    const userMessages = messages.filter((msg) => msg.author.id === message.author.id);

    const botMessagesToDelete = Array.from(botMessages.values()).slice(1);
    await Promise.all(botMessagesToDelete.map((msg) => msg.delete()));

    const userMessagesToDelete = Array.from(userMessages.values()).slice(1);
    await Promise.all(userMessagesToDelete.map((msg) => msg.delete()));

    // Send New, Active, and Completed task lists
    await sendTaskMessages("New Tasks", newTaskDisplay);
    await sendTaskMessages("Active Tasks", activeTaskDisplay);
    await sendTaskMessages("Completed Tasks", completedTaskDisplay);
}


async function start(message, args, adminUserIds) {
    users.handleNewMessage(message);
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
        case 'add':
            // Check for quoted format: "task1", "task2", "task3"
            const quotedTaskNames = args.slice(1).join(' ').match(/"([^"]+)"/g)?.map(name => name.replace(/"/g, '').trim());
        
            if (quotedTaskNames && quotedTaskNames.length > 0) {
                // Add tasks from quoted format
                const addedTasks = [];
                const skippedTasks = [];
        
                for (const taskName of quotedTaskNames) {
                    const isDuplicate = tasksData.tasks.some(task => task.taskName === taskName);
                    if (isDuplicate) {
                        skippedTasks.push(taskName);
                        continue;
                    }
        
                    const newTask = {
                        taskId: tasksData.currentTaskId,
                        taskName,
                        date: new Date().toISOString(),
                        status: 'New',
                        assigned: '',
                    };
                    tasksData.tasks.push(newTask);
                    tasksData.currentTaskId++;
                    addedTasks.push(`[${newTask.taskId}] ${newTask.taskName}`);
                }
        
                saveTasks(guildId, tasksData);
        
                // Send confirmation message
                const addedMessage = addedTasks.length > 0 ? `Tasks added:\n${addedTasks.join('\n')}` : "No new tasks added.";
                const skippedMessage = skippedTasks.length > 0 ? `Skipped duplicates:\n${skippedTasks.join(', ')}` : "";
                await message.channel.send(`${addedMessage}${skippedMessage ? `\n${skippedMessage}` : ""}`);
            } else {
                // Old method: Single plain text task
                const taskName = args.slice(1).join(' ').trim();
                if (!taskName) {
                    await message.channel.send("Please provide a task name or use the format: !add \"task1\", \"task2\", \"task3\"");
                    return;
                }
        
                const isDuplicate = tasksData.tasks.some(task => task.taskName === taskName);
                if (isDuplicate) {
                    await message.channel.send(`Task "${taskName}" is already in the list.`);
                    return;
                }
        
                const newTask = {
                    taskId: tasksData.currentTaskId,
                    taskName,
                    date: new Date().toISOString(),
                    status: 'New',
                    assigned: '',
                };
        
                tasksData.tasks.push(newTask);
                tasksData.currentTaskId++;
                saveTasks(guildId, tasksData);
        
                // Confirm single task addition
                await message.channel.send(`Task added: [${newTask.taskId}] ${newTask.taskName}`);
            }
            break;

        case 'done':
            const doneTaskId = parseInt(args[1]);
            const doneTask = tasksData.tasks.find((task) => task.taskId === doneTaskId);
            if (doneTask) {
                doneTask.status = 'Completed';
                saveTasks(guildId, tasksData);
                logStat(guildId, message.author.id, doneTask.taskId, doneTask.taskName, 'Completed');
                await message.channel.send(`Task marked as completed: [${doneTask.taskId}] ${doneTask.taskName}`);
            } else {
                await message.channel.send(`Task with ID ${doneTaskId} not found.`);
            }
            break;

        case 'clear':
            tasksData.tasks = tasksData.tasks.filter((task) => task.status !== 'Completed');
            saveTasks(guildId, tasksData);
            await message.channel.send(`Completed tasks have been cleared.`);
            break;

        case 'delete':
            // Join all arguments after the command to handle multi-part IDs
            const idsString = args.slice(1).join(' ');
            console.log("Raw input for IDs:", idsString);

            // Parse task IDs from the arguments
            const deleteTaskIds = idsString.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
            console.log("Parsed IDs to delete:", deleteTaskIds);

            const deletedTasks = [];

            // Filter tasks for deletion in one pass
            const remainingTasks = tasksData.tasks.filter((task) => {
                if (deleteTaskIds.includes(task.taskId)) {
                    deletedTasks.push(task);
                    logStat(guildId, message.author.id, task.taskId, task.taskName, 'Abandoned');
                    return false; // Exclude from remaining tasks
                }
                return true; // Keep in remaining tasks
            });

            // Update the tasks array with remaining tasks
            tasksData.tasks = remainingTasks;

            // Identify tasks that weren't found
            const foundTaskIds = deletedTasks.map(task => task.taskId);
            const notFoundDeletedTasks = deleteTaskIds.filter(taskId => !foundTaskIds.includes(taskId));

            // Debugging: Log results of deletion process
            console.log("Deleted tasks:", deletedTasks);
            console.log("Tasks not found:", notFoundDeletedTasks);

            // Save the updated tasks
            if (deletedTasks.length > 0) {
                saveTasks(guildId, tasksData);
                await message.channel.send(`Tasks deleted: ${deletedTasks.map(task => `[${task.taskId}] ${task.taskName}`).join(', ')}`);
            }

            // Notify about tasks not found
            if (notFoundDeletedTasks.length > 0) {
                await message.channel.send(`Tasks not found: ${notFoundDeletedTasks.join(', ')}`);
            }
            break;

        case 'take':
            // Parse the task IDs from the arguments (e.g., "2,3,5,6,2")
            const taskIds = args.slice(1).join('').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        
            if (taskIds.length === 0) {
                await message.channel.send("Please provide valid task IDs to take, e.g., `!take 2,3,5`.");
                return;
            }
        
            const takenTasks = [];
            const alreadyActiveTasks = [];
            const notFoundTasks = [];
        
            // Process each task ID
            for (const taskId of new Set(taskIds)) { // Use Set to avoid processing duplicates
                const task = tasksData.tasks.find((t) => t.taskId === taskId);
        
                if (task && task.status === 'New') {
                    task.status = 'Active';
                    task.assigned = message.author.id;
                    takenTasks.push(`[${task.taskId}] ${task.taskName}`);
                } else if (task && task.status === 'Active') {
                    alreadyActiveTasks.push(`[${task.taskId}] ${task.taskName}`);
                } else {
                    notFoundTasks.push(taskId);
                }
            }
        
            saveTasks(guildId, tasksData);
        
            // Prepare response messages
            const takenMessage = takenTasks.length > 0 ? `Tasks taken:\n${takenTasks.join('\n')}` : "";
            const activeMessage = alreadyActiveTasks.length > 0 ? `Already active:\n${alreadyActiveTasks.join('\n')}` : "";
            const notFoundMessage = notFoundTasks.length > 0 ? `Not found or cannot be taken:\n${notFoundTasks.join(', ')}` : "";
        
            // Send a summary response
            await message.channel.send(`${takenMessage}${activeMessage ? `\n\n${activeMessage}` : ""}${notFoundMessage ? `\n\n${notFoundMessage}` : ""}`);
            break;
        default:
            await message.channel.send(`Unknown task command: ${command}`);
            break;
    }

    // Refresh and display the task list
    await displayTaskList(message, guildId);
}

module.exports = { start };
