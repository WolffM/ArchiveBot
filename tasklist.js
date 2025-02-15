const fs = require('fs');
const path = require('path');
const users = require('./users');
const helper = require('./helper');
const { migrateGuild } = require('./migrate');

const VALID_STATUSES = ['New', 'Active', 'Completed', 'Abandoned'];

function getNextTaskId(tasksData) {
    if (!tasksData.tasks || !Array.isArray(tasksData.tasks) || tasksData.tasks.length === 0) {
        return 1;
    }
    const validIds = tasksData.tasks
        .map(task => parseInt(task.id))
        .filter(id => !isNaN(id));
    return Math.max(...validIds, 0) + 1;
}

function loadTasks(guildId) {
    const guildPath = users.getGuildPath(guildId);
    helper.ensureDirectoryExists(guildPath);
    const filePath = path.join(guildPath, 'tasks.json');
    
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath));
    } else {
        const initialData = { tasks: [] };
        fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2));
        return initialData;
    }
}

function validateTask(task) {
    return {
        id: task.id,
        name: task.name || '',
        created: task.created || new Date().toISOString(),
        status: VALID_STATUSES.includes(task.status) ? task.status : 'New',
        assigned: task.assigned || '',
        history: Array.isArray(task.history) ? task.history : [{
            date: task.created || new Date().toISOString(),
            action: 'Created',
            userId: task.assigned || 'unknown'
        }]
    };
}

function processTaskNames(args, tasksData, guildId, user) {
    const quotedTaskNames = args.join(' ').match(/"([^"]+)"/g)?.map((name) => name.replace(/"/g, '').trim());
    const addedTasks = [];
    const skippedTasks = [];

    (quotedTaskNames || [args.join(' ').trim()]).forEach((taskName) => {
        if (!taskName) return;

        const isDuplicate = tasksData.tasks.some((task) => task.name === taskName);
        if (isDuplicate) {
            skippedTasks.push(taskName);
        } else {
            const nextId = getNextTaskId(tasksData);
            const newTask = {
                id: nextId,
                name: taskName,
                created: new Date().toISOString(),
                status: 'New',
                assigned: '',
                history: [{
                    date: new Date().toISOString(),
                    action: 'Created',
                    userId: user.id
                }]
            };
            tasksData.tasks.push(newTask);
            addedTasks.push(newTask);
        }
    });

    helper.saveTasks(guildId, tasksData);
    
    return { 
        addedTasks, 
        skippedTasks,
        message: addedTasks.length > 0 ? `Tasks added:\n${addedTasks.map(task => `[${task.id}] ${task.name}`).join('\n')}` : 'No tasks added.'
    };
}

async function displayTaskList(message, guildId) {
    const tasksData = loadTasks(guildId);

    // Delete previous messages
    try {
        const messages = await message.channel.messages.fetch({ limit: 100 });
        const messagesToDelete = messages.filter(msg => 
            // Keep the last command message
            msg.id !== message.id &&
            // Only delete bot messages and command messages
            (msg.author.bot || msg.content.startsWith('/'))
        );
        
        if (messagesToDelete.size > 0) {
            await message.channel.bulkDelete(messagesToDelete);
        }
    } catch (error) {
        console.error('Error cleaning up messages:', error);
        // Continue with display even if cleanup fails
    }

    // Helper function to truncate string dynamically
    const truncateString = (str, maxLength) => {
        if (!str) return '';
        return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
    };

    // Helper function to create table
    const createTable = (title, tasks, headers, columnSelectors) => {
        if (!tasks || tasks.length === 0) {
            return "No tasks available.";
        }

        const maxRowWidth = 50;
        const separatorWidth = headers.length - 1; // Account for separators

        // Calculate initial max lengths for each column
        const maxLengths = headers.map((header, index) => {
            const columnValues = tasks.map(task => {
                const value = columnSelectors[index](task);
                return value !== undefined && value !== null ? value.toString() : '';
            });
            return Math.max(
                header.length,
                ...columnValues.map(val => val.length)
            );
        });

        // Calculate total width and adjust task name column if needed
        const totalWidth = maxLengths.reduce((sum, length) => sum + length, 0) + separatorWidth;
        if (totalWidth > maxRowWidth) {
            const taskNameIndex = headers.indexOf("Task Name");
            if (taskNameIndex !== -1) {
                const excessWidth = totalWidth - maxRowWidth;
                maxLengths[taskNameIndex] = Math.max(10, maxLengths[taskNameIndex] - excessWidth);
            }
        }

        // Create header and separator
        const headerRow = `| ${headers.map((h, i) => h.padEnd(maxLengths[i])).join(' | ')} |`;
        const separatorRow = `|-${maxLengths.map((len) => '-'.repeat(len)).join('-|-')}-|`;

        // Create task rows with proper truncation
        const taskRows = tasks.map((task) => {
            const row = columnSelectors.map((selector, i) => {
                const value = selector(task);
                const strValue = value !== undefined && value !== null ? value.toString() : '';
                return truncateString(strValue, maxLengths[i]).padEnd(maxLengths[i]);
            });

            return `| ${row.join(' | ')} |`;
        });

        return [headerRow, separatorRow, ...taskRows].join('\n');
    };

    // Define New Tasks Table
    const newTasks = tasksData.tasks.filter((task) => 
        task && task.status === 'New' && task.id && task.name
    );
    const newTaskHeaders = ["ID", "Task Name", "Age"];
    const newTaskSelectors = [
        (task) => task.id?.toString(),
        (task) => task.name,
        (task) => helper.calculateAge(task.created)
    ];
    const newTaskDisplay = createTable("New Tasks", newTasks, newTaskHeaders, newTaskSelectors);

    // Define Active Tasks Table
    const activeTasks = tasksData.tasks.filter((task) => 
        task && task.status === 'Active' && task.id && task.name
    );
    const activeTaskHeaders = ["ID", "Task Name", "Age", "Assigned"];
    const activeTaskSelectors = [
        (task) => task.id?.toString(),
        (task) => task.name,
        (task) => helper.calculateAge(task.created),
        (task) => task.assigned ? users.getDisplayName(task.assigned, guildId) : "Unassigned"
    ];
    const activeTaskDisplay = createTable("Active Tasks", activeTasks, activeTaskHeaders, activeTaskSelectors);

    // Fix Completed Tasks Table
    const completedTasks = tasksData.tasks.filter(task => {
        if (!task || task.status !== 'Completed') return false;
        if (!Array.isArray(task.history)) return false;
        return true;  // If it has Completed status and valid history array, show it
    });

    const completedTaskHeaders = ["ID", "Task Name", "Date", "Completed By", "Status"];
    const completedTaskSelectors = [
        (task) => task.id?.toString() || '',
        (task) => task.name || '',
        (task) => {
            const completedEntry = task.history.find(h => h.action === 'Completed') || 
                                 task.history[task.history.length - 1];
            return new Date(completedEntry.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric'
            });
        },
        (task) => {
            // First try to get the user from the Completed entry
            const completedEntry = task.history.find(h => h.action === 'Completed');
            // If no Completed entry, use the task's assigned field
            const userId = completedEntry ? completedEntry.userId : task.assigned;
            return users.getDisplayName(userId, guildId);
        },
        (task) => task.status
    ];

    const completedTaskDisplay = createTable("Completed Tasks", completedTasks, completedTaskHeaders, completedTaskSelectors);

    // Send the task lists
    const sendTaskMessages = async (title, taskDisplay) => {
        const chunks = helper.splitMessage(taskDisplay);
        for (let i = 0; i < chunks.length; i++) {
            const content = i === 0 ? `**${title}**\n\`\`\`\n${chunks[i]}\n\`\`\`` : `\`\`\`\n${chunks[i]}\n\`\`\``;
            await message.channel.send(content);
        }
    };

    // Display tasks
    await sendTaskMessages("New Tasks", newTaskDisplay);
    await sendTaskMessages("Active Tasks", activeTaskDisplay);
    await sendTaskMessages("Completed Tasks", completedTaskDisplay);
}

// Helper function to handle commands that take multiple task IDs
async function handleTaskIdsCommand(interaction, command, validateTasks) {
    const idInput = interaction.options.getString('id');
    if (!idInput) {
        await interaction.reply({ content: 'Please provide at least one task ID.', ephemeral: true });
        return null;
    }

    // Split and validate IDs
    const taskIds = idInput.split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0);

    // Validate that each ID is numeric
    for (const id of taskIds) {
        if (isNaN(parseInt(id))) {
            await interaction.reply({ content: `Invalid task id: ${id}`, ephemeral: true });
            return null;
        }
    }

    const tasksData = loadTasks(interaction.guild.id);
    const invalidIds = validateTasks(taskIds, tasksData);

    if (invalidIds.length > 0) {
        await interaction.reply({ 
            content: `${invalidIds.join(', ')} ${invalidIds.length === 1 ? 'is' : 'are'} invalid.`, 
            ephemeral: true 
        });
        return null;
    }

    // Return the correct command with the task IDs
    return [command, ...taskIds];
}

async function handleSlashCommand(interaction, adminUserIds) {
    const guildId = interaction.guild.id;

    try {
        const messageProxy = {
            guild: interaction.guild,
            channel: interaction.channel,
            author: interaction.user,
            client: interaction.client,
            id: interaction.id
        };

        let args = [];
        switch (interaction.commandName) {
            case 'done': {
                // Validate tasks aren't already completed
                const validateDone = (taskIds, tasksData) => taskIds.filter(id => {
                    const taskId = parseInt(id);
                    const task = tasksData.tasks.find(t => t.id === taskId);
                    return !task || task.status === 'Completed';
                });
                
                args = await handleTaskIdsCommand(interaction, 'done', validateDone);
                if (!args) return;
                break;
            }
            case 'delete': {
                // Only validate tasks exist
                const validateDelete = (taskIds, tasksData) => taskIds.filter(id => {
                    const taskId = parseInt(id);
                    return !tasksData.tasks.find(t => t.id === taskId);
                });
                
                args = await handleTaskIdsCommand(interaction, 'delete', validateDelete);
                if (!args) return;
                break;
            }
            case 'migrate': {
                // Only allow admins to run migration
                if (!adminUserIds.includes(interaction.user.id)) {
                    await interaction.reply({ 
                        content: 'Only administrators can run the migration command.', 
                        ephemeral: true 
                    });
                    return;
                }

                // Defer the reply since migration might take time
                await interaction.deferReply({ ephemeral: true });

                try {
                    const result = await migrateGuild(guildId);
                    
                    // After migration, refresh the task display
                    await start(messageProxy, ['list'], adminUserIds);
                    
                    // Edit the deferred reply
                    await interaction.editReply({ content: result });
                } catch (error) {
                    await interaction.editReply({ 
                        content: `Migration failed: ${error.message}` 
                    });
                }
                return; // Important: return here to prevent double replies
            }
            case 'task':
                args = ['add', interaction.options.getString('description')];
                break;
            case 'take':
                args = ['take', interaction.options.getInteger('id').toString()];
                break;
            case 'tasks':
                args = ['testt'];
                break;
            case 'init':
                args = ['init'];
                break;
        }

        // Only send the "Processing command..." reply for non-migrate commands
        if (interaction.commandName !== 'migrate') {
            await interaction.reply({ content: 'Processing command...', ephemeral: true });
            const result = await start(messageProxy, args, adminUserIds);
        }

    } catch (error) {
        console.error('Command error:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: `Error: ${error.message}`, 
                ephemeral: true 
            });
        }
    }
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
                const { addedTasks, skippedTasks, message: addedMessage } = await processTaskNames(args.slice(1), tasksData, guildId, message.author);
                await message.channel.send(addedMessage);
            } catch (error) {
                await message.channel.send(error.message);
            }
            break;
        }       

        case 'done': {
            try {
                if (args.join(' ').includes('"')) {
                    // Handle quoted task names
                    const { addedTasks, skippedTasks, message: addedMessage } = await processTaskNames(args.slice(1), tasksData, guildId, message.author);
        
                    // Immediately mark added tasks as completed
                    addedTasks.forEach((task) => helper.updateTaskStatus(task, 'Completed', message.author.id));
                    helper.saveTasks(guildId, tasksData);
        
                    await message.channel.send(addedMessage);
                } else {
                    // Handle numeric task IDs
                    const taskIds = helper.parseTaskIds(args);
                    const validIds = helper.validateTaskIds(taskIds, tasksData);
                    const tasks = helper.getTasksByIds(validIds, tasksData);
        
                    tasks.forEach((task) => helper.updateTaskStatus(task, 'Completed', message.author.id));
                    helper.saveTasks(guildId, tasksData);
        
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
                
                // Add 'Deleted' to history before removing
                deletedTasks.forEach(task => {
                    task.history.push({
                        date: new Date().toISOString(),
                        action: 'Abandoned',
                        userId: message.author.id
                    });
                });
                
                tasksData.tasks = tasksData.tasks.filter((task) => !validIds.includes(task.id));
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
    await helper.cleanupTasks(message.channel, tasksData);
    await displayTaskList(message, guildId);
}

async function initialize(message, guildId) {
    const guildPath = users.getGuildPath(guildId);
    helper.ensureDirectoryExists(guildPath);

    const tasksFilePath = path.join(guildPath, 'tasks.json');
    const usersFilePath = path.join(guildPath, 'users.json');

    // Initialize tasks.json with new structure
    const initialTasksData = {
        tasks: []
    };
    fs.writeFileSync(tasksFilePath, JSON.stringify(initialTasksData, null, 2));

    // Initialize users.json if it doesn't exist
    if (!fs.existsSync(usersFilePath)) {
        fs.writeFileSync(usersFilePath, JSON.stringify({}, null, 2));
    }

    // Optional: Attempt to migrate existing data if found
    const oldStatsPath = path.join(guildPath, 'stats.csv');
    if (fs.existsSync(oldStatsPath)) {
        try {
            console.log('Found old stats file, attempting to migrate...');
            const oldTasksData = JSON.parse(fs.readFileSync(tasksFilePath));
            
            // Backup old files
            fs.renameSync(oldStatsPath, `${oldStatsPath}.backup`);
            fs.renameSync(tasksFilePath, `${tasksFilePath}.backup`);
            
            // Create fresh tasks.json with new structure
            fs.writeFileSync(tasksFilePath, JSON.stringify(initialTasksData, null, 2));
            
            await message.channel.send('Tasklist initialized successfully! (Old data backed up)');
        } catch (error) {
            console.error('Migration error:', error);
            await message.channel.send('Tasklist initialized with fresh data. (Migration failed)');
        }
    } else {
        await message.channel.send('Tasklist initialized successfully!');
    }
}

async function migrateStatsToHistory(guildId) {
    const statsPath = `Output/tasklist/${guildId}/stats.csv`;
    const tasksPath = `Output/tasklist/${guildId}/tasks.json`;
    
    try {
        // Read and parse stats.csv
        const statsContent = fs.readFileSync(statsPath, 'utf8');
        const rows = statsContent.split('\n')
            .slice(1) // Skip header row
            .filter(row => row.trim()) // Remove empty lines
            .map(row => {
                const [userId, taskId, taskName, date, status] = row.split(',');
                return {
                    userId,
                    taskId: parseInt(taskId),
                    taskName,
                    date,
                    status
                };
            });

        // Read and parse tasks.json
        const tasksData = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));

        // Update each task with its history from stats
        tasksData.tasks = tasksData.tasks.map(task => {
            // Find all stats entries for this task
            const taskStats = rows.filter(stat => stat.taskId === task.id);
            
            // Sort by date to ensure correct order
            taskStats.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            // Get the final status from the most recent stat
            const finalStat = taskStats[taskStats.length - 1];
            if (finalStat) {
                task.status = finalStat.status;
                
                // Update history with all status changes
                task.history = [
                    // Keep the Created entry if it exists
                    ...task.history.filter(h => h.action === 'Created'),
                    // Add entries from stats
                    ...taskStats.map(stat => ({
                        date: stat.date,
                        action: stat.status,
                        userId: stat.userId
                    }))
                ];
            }
            
            return task;
        });

        // Write updated tasks back to file
        fs.writeFileSync(tasksPath, JSON.stringify(tasksData, null, 2));
        
        return `Migration completed. Updated ${tasksData.tasks.length} tasks with history from stats.`;
    } catch (error) {
        console.error('Migration error:', error);
        throw new Error(`Failed to migrate stats: ${error.message}`);
    }
}

module.exports = { 
    start, 
    handleSlashCommand,
    loadTasks,
    validateTask
};