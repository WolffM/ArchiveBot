const fs = require('fs');
const path = require('path');
const users = require('../utils/users');
const helper = require('../utils/helper');
const permissions = require('./permissions');
const { createLogger } = require('../utils/logger');

const log = createLogger('tasklist');

/*
Task Schema:
{
    id: number,                 // Unique identifier for the task
    name: string,               // Description of the task
    createdDate: timestamp,     // ISO timestamp of when task was created
    status: string,             // "New", "Active", or "Completed"
    assigned: string            // Discord user ID, or empty string if unassigned
    category?: string           // Optional. Category of the task
    completedDate?: timestamp   // Optional. ISO timestamp of when task was completed
}
*/

const VALID_STATUSES = ['New', 'Active', 'Completed'];

/**
 * Parse comma-separated task IDs from input string
 * @param {string} input - Input string with comma-separated IDs
 * @returns {number[]} Array of valid task IDs
 */
function parseTaskIdsFromInput(input) {
    return input.split(',')
        .map(id => id.trim())
        .filter(id => !isNaN(id))
        .map(id => parseInt(id));
}

/**
 * Find tasks by IDs and track which IDs weren't found
 * @param {number[]} taskIds - Array of task IDs to find
 * @param {Object} tasksData - Tasks data object
 * @returns {{found: Object[], notFoundIds: number[]}}
 */
function findTasksById(taskIds, tasksData) {
    const found = [];
    const notFoundIds = [];

    taskIds.forEach(id => {
        const task = tasksData.tasks.find(t => t.id === id);
        if (task) {
            found.push(task);
        } else {
            notFoundIds.push(id);
        }
    });

    return { found, notFoundIds };
}

/**
 * Format a response message for task operations
 * @param {string} verb - Action verb (e.g., "deleted", "completed")
 * @param {Object[]} tasks - Processed tasks
 * @param {number[]} notFoundIds - IDs that weren't found
 * @returns {string} Formatted response message
 */
function formatTaskResponse(verb, tasks, notFoundIds = []) {
    let response = `${verb} ${tasks.length} task(s):\n${tasks.map(t => `#${t.id}: ${t.name}`).join('\n')}`;
    if (notFoundIds.length > 0) {
        response += `\n\nNote: Could not find tasks with IDs: ${notFoundIds.join(', ')}`;
    }
    return response;
}

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

        // Check if any messages are older than 14 days
        const hasOldMessages = messagesToDelete.some(msg =>
            Date.now() - msg.createdTimestamp >= 14 * 24 * 60 * 60 * 1000
        );

        if (messagesToDelete.size > 0) {
            if (hasOldMessages) {
                // Delete messages one by one if there are old messages
                for (const msg of messagesToDelete.values()) {
                    try {
                        await msg.delete();
                    } catch (e) {
                        // Only log non-10008 errors (unknown message)
                        if (e.code !== 10008) {
                            log.error('displayTaskList', e, { phase: 'delete message' });
                        }
                    }
                }
            } else {
                // Use bulk delete for recent messages
                await message.channel.bulkDelete(messagesToDelete);
            }
        }
    } catch (error) {
        log.error('displayTaskList', error, { phase: 'cleanup messages' });
        // Continue with display even if cleanup fails
    }

    // Helper function to truncate string dynamically
    const truncateString = (str, maxLength) => {
        if (!str) return '';
        return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
    };

    // Helper function to create table
    const createTable = (tasks, headers, columnSelectors) => {
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

    // Send the task lists
    const sendTaskMessages = async (title, taskDisplay) => {
        const chunks = helper.splitMessage(taskDisplay);
        for (let i = 0; i < chunks.length; i++) {
            const content = i === 0
                ? `**${title}**\n\`\`\`\n${chunks[i]}\n\`\`\``
                : `\`\`\`\n${chunks[i]}\n\`\`\``;
            await message.channel.send(content);
        }
    };

    // --- New Tasks Table (grouped by category) ---
    const newTasks = tasksData.tasks.filter(task =>
        task && task.status === 'New' && task.id && task.name
    );

    // Group tasks: use an empty string for tasks with no category.
    const groupedTasks = {};
    newTasks.forEach(task => {
        const cat = (task.category && task.category.trim()) || "";
        if (!groupedTasks[cat]) {
            groupedTasks[cat] = [];
        }
        groupedTasks[cat].push(task);
    });

    // Sort group keys so that tasks with no category (empty string) come first,
    // then the rest sorted alphabetically.
    const sortedCategories = Object.keys(groupedTasks).sort((a, b) => {
        if (a === "") return -1;
        if (b === "") return 1;
        return a.localeCompare(b);
    });

    for (const category of sortedCategories) {
        const tasks = groupedTasks[category];
        // Use "New Tasks" as header for tasks with no category; otherwise include the category name.
        // Capitalize the first letter of the category for display
        const displayCategory = category ? 
            category.charAt(0).toUpperCase() + category.slice(1) : "";
        const header = displayCategory || "🌟  New Tasks 🌟";
        const newTaskHeaders = ["ID", "Task Name", "Age"];
        const newTaskSelectors = [
            (task) => task.id?.toString(),
            (task) => task.name,
            (task) => helper.calculateAge(task.createdDate)
        ];
        const tableDisplay = createTable(tasks, newTaskHeaders, newTaskSelectors);
        await sendTaskMessages(header, tableDisplay);
    }

    // --- Active Tasks Table ---
    const activeTasks = tasksData.tasks.filter((task) =>
        task && task.status === 'Active' && task.id && task.name
    );
    const activeTaskHeaders = ["ID", "Task Name", "Age", "Assigned"];
    const activeTaskSelectors = [
        (task) => task.id?.toString(),
        (task) => task.name,
        (task) => helper.calculateAge(task.createdDate),
        (task) => task.assigned ? users.getDisplayName(task.assigned, guildId) : "Unassigned"
    ];
    const activeTaskDisplay = createTable(activeTasks, activeTaskHeaders, activeTaskSelectors);
    await sendTaskMessages("✏️ Active Tasks ✏️", activeTaskDisplay);
}

async function processTaskAction(interaction, action) {
    // Don't defer reply if already replied or deferred
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false });
    }

    try {        
        // Get input based on command type and handle parameter name inconsistencies
        let input = null;
        
        // Try all possible parameter names based on command
        if (action === 'create') {
            // Try 'name' first (new style), then 'description' (old style)
            input = interaction.options.getString('name') || 
                    interaction.options.getString('description');
        } else if (action === 'delete' || action === 'tag') {
            // Try 'id' first (new style), then 'tasks' (old style) 
            input = interaction.options.getString('id') || 
                    interaction.options.getString('tasks');
        } else {
            // For take/done commands, try 'name' first (new style), then 'tasks' (old style)
            input = interaction.options.getString('name') || 
                    interaction.options.getString('tasks');
        }
        
        // Validate input
        if (!input) {
            throw new Error(`No ${action === 'create' ? 'task description' : 'task IDs'} provided.`);
        }
        
        const tasksData = loadTasks(interaction.guild.id);
        let processedTasks = [];
        
        // Try both category and tag parameter names
        const categoryValue = interaction.options.getString('category') || 
                             interaction.options.getString('tag') || '';
        
        // Convert category to lowercase for storage
        const lowerCaseCategory = categoryValue.toLowerCase();

        // Set up action properties based on action string or object
        let newStatus, verb, assignUser;
        
        if (typeof action === 'string') {
            // Handle string actions
            switch (action) {
                case 'create':
                    newStatus = 'New';
                    verb = 'created';
                    assignUser = false;
                    break;
                case 'take':
                    newStatus = 'Active';
                    verb = 'taken';
                    assignUser = true;
                    break;
                case 'complete':
                    newStatus = 'Completed';
                    verb = 'completed';
                    assignUser = true;
                    break;
                case 'delete':
                    // Special case handling below
                    verb = 'deleted';
                    break;
                case 'tag':
                    // Special case handling below
                    verb = 'tagged';
                    break;
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        } else {
            // Handle object actions (legacy format)
            newStatus = action.newStatus;
            verb = action.verb;
            assignUser = action.assignUser;
        }

        // Special handling for delete
        if (action === 'delete') {
            const taskIds = parseTaskIdsFromInput(input);
            if (taskIds.length === 0) {
                throw new Error('No valid task IDs provided.');
            }

            const { found: tasksToDelete, notFoundIds } = findTasksById(taskIds, tasksData);
            if (tasksToDelete.length === 0) {
                throw new Error('None of the provided task IDs exist.');
            }

            tasksData.tasks = tasksData.tasks.filter(task => !taskIds.includes(task.id));
            processedTasks = tasksToDelete;

            await interaction.editReply({
                content: formatTaskResponse('Deleted', processedTasks, notFoundIds)
            });
        }
        // Special handling for tag
        else if (action === 'tag') {
            const categoryParam = interaction.options.getString('category') ||
                                 interaction.options.getString('tag');
            if (!categoryParam) {
                throw new Error('No category provided.');
            }

            const tagLowerCase = categoryParam.toLowerCase();
            const taskIds = parseTaskIdsFromInput(input);
            if (taskIds.length === 0) {
                throw new Error('No valid task IDs provided.');
            }

            const { found: existingTasks, notFoundIds } = findTasksById(taskIds, tasksData);
            if (existingTasks.length === 0) {
                throw new Error('None of the provided task IDs exist.');
            }

            existingTasks.forEach(task => task.category = tagLowerCase);
            processedTasks = existingTasks;

            const displayCategory = categoryParam.charAt(0).toUpperCase() + categoryParam.slice(1).toLowerCase();
            let response = `Assigned category "${displayCategory}" to ${processedTasks.length} task(s):\n${processedTasks.map(t => `#${t.id}: ${t.name}`).join('\n')}`;
            if (notFoundIds.length > 0) {
                response += `\n\nNote: Could not find tasks with IDs: ${notFoundIds.join(', ')}`;
            }
            await interaction.editReply({ content: response });
        }
        // Handle regular create/take/complete actions
        else if (action === 'create' || input.includes('"')) {
            let descriptions = [];
            
            // Handle different input formats for task creation
            if (action === 'create') {
                if (input.includes('"')) {
                    // Extract quoted strings - handle format: "task1", "task2", "task3"
                    descriptions = input.match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').trim());
                } 
                
                if (!descriptions || descriptions.length === 0) {
                    if (input.includes(',') && !input.includes('"')) {
                        // Handle comma-separated format without quotes: task1,task2,task3
                        descriptions = input.split(',').map(item => item.trim()).filter(item => item.length > 0);
                    } else {
                        // Handle single task format: task1
                        descriptions = [input.trim()];
                    }
                }
            } else {
                // For non-create actions, use the existing quote parsing logic
                descriptions = input.match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').trim()) || [input];
            }
                
            if (!descriptions.length) {
                throw new Error('Invalid task description format. Use "task name" for descriptions or comma-separated values without spaces.');
            }

            // Create and process new tasks
            descriptions.forEach(description => {
                if (!description.trim()) return;

                const newTask = {
                    id: getNextTaskId(tasksData),
                    name: description,
                    createdDate: new Date().toISOString(),
                    status: newStatus,
                    assigned: assignUser ? interaction.user.id : '',
                    category: lowerCaseCategory
                };

                // If the task is being completed, add the completed date field
                if (newStatus === 'Completed') {
                    newTask.completedDate = new Date().toISOString();
                }

                tasksData.tasks.push(newTask);
                processedTasks.push(newTask);
            });

            await interaction.editReply({
                content: `Created and ${verb} ${processedTasks.length} task(s):\n${processedTasks.map(t => `#${t.id}: ${t.name}`).join('\n')}`
            });
        } else {
            // Handle task IDs for take/complete actions
            const taskIds = parseTaskIdsFromInput(input);
            if (taskIds.length === 0) {
                throw new Error('No valid task IDs provided.');
            }

            const { found: existingTasks, notFoundIds } = findTasksById(taskIds, tasksData);
            if (existingTasks.length === 0) {
                throw new Error('None of the provided task IDs exist.');
            }

            // Process existing tasks
            existingTasks.forEach(task => {
                task.status = newStatus;
                if (assignUser) {
                    task.assigned = interaction.user.id;
                }
                if (newStatus === 'Completed') {
                    task.completedDate = new Date().toISOString();
                }
                processedTasks.push(task);
            });

            // Capitalize the verb for display
            const displayVerb = verb.charAt(0).toUpperCase() + verb.slice(1);
            await interaction.editReply({
                content: formatTaskResponse(displayVerb, processedTasks, notFoundIds)
            });
        }

        helper.saveTasks(interaction.guild.id, tasksData);

        log.success('processTaskAction', {
            action: typeof action === 'string' ? action : action.verb,
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            taskCount: processedTasks.length,
            taskIds: processedTasks.map(t => t.id)
        });

        await displayTaskList(createMessageProxy(interaction), interaction.guild.id);
    } catch (error) {
        log.error('processTaskAction', error, {
            action: typeof action === 'string' ? action : 'unknown',
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });
        await interaction.editReply({
            content: `Error: ${error.message}`
        });
    }
}


function createMessageProxy(interaction) {
    return {
        guild: interaction.guild,
        channel: interaction.channel,
        author: interaction.user,
        client: interaction.client,
        id: interaction.id
    };
}

async function handleSlashCommand(interaction) {
    const { commandName } = interaction;
    const guildId = interaction.guild.id;
    
    // Check if the user has task access before processing any task command
    const hasTaskAccess = await permissions.checkTaskAccessWithRoles(interaction.user.id, interaction.guild);
    if (!hasTaskAccess) {
        await interaction.reply({
            content: 'You do not have permission to use the task system. Please ask an admin for access.',
            ephemeral: true
        });
        return;
    }
    
    if (commandName === 'init') {
        // Only defer reply for this specific command
        await interaction.deferReply({ ephemeral: true });
        const tasksData = loadTasks(guildId);
        await interaction.editReply(`Task system initialized. There are currently ${tasksData.tasks.length} tasks.`);
        return;
    }
    
    // Create a proxy message object to work with the existing display function
    const messageProxy = createMessageProxy(interaction);
    
    // Handle specific commands without deferring reply here,
    // since the called functions will handle that themselves
    switch (commandName) {
        case 'task':
            // The task command creates new tasks
            await processTaskAction(interaction, 'create');
            break;
            
        case 'take':
            // The take command assigns tasks to the user
            await processTaskAction(interaction, 'take');
            break;
            
        case 'done':
            // The done command completes tasks
            await processTaskAction(interaction, 'complete');
            break;
            
        case 'delete':
            // The delete command removes tasks
            await processTaskAction(interaction, 'delete');
            break;
            
        case 'tag':
            // The tag command categorizes tasks
            await processTaskAction(interaction, 'tag');
            break;
            
        case 'history':
            await interaction.deferReply({ ephemeral: true });
            const tasksData = loadTasks(guildId);
            const completedTasks = tasksData.tasks.filter(task => 
                task && task.status === 'Completed' && task.completedDate
            );
            
            // Sort by completed date, most recent first
            completedTasks.sort((a, b) => 
                new Date(b.completedDate) - new Date(a.completedDate)
            );
            
            // Limit to most recent 100 tasks
            const recentTasks = completedTasks.slice(0, 100);
            
            if (recentTasks.length === 0) {
                await interaction.editReply('No completed tasks found.');
                return;
            }
            
            const taskListText = recentTasks.map(task => 
                `- ${task.name} (ID: ${task.id}, Completed: ${new Date(task.completedDate).toLocaleDateString()})`
            ).join('\n');
            
            await interaction.editReply({
                content: 'Recently completed tasks:',
                ephemeral: true,
                embeds: [{
                    title: 'Task History',
                    description: taskListText.length > 4000 
                        ? taskListText.substring(0, 4000) + '...'
                        : taskListText,
                    color: 0x00ff00
                }]
            });
            break;
            
        default:
            await interaction.reply({
                content: 'Unknown command.',
                ephemeral: true
            });
            break;
    }
}

module.exports = {
    handleSlashCommand,
    loadTasks,
    // Pure functions exported for testing
    getNextTaskId,
};