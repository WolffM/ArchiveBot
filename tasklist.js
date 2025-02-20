const fs = require('fs');
const path = require('path');
const users = require('./users');
const helper = require('./helper');

/*
Task Schema:
{
    id: number,          // Unique identifier for the task
    name: string,        // Description of the task
    created: string,     // ISO timestamp of when task was created
    status: string,      // "New", "Active", or "Completed"
    assigned: string     // Discord user ID, or empty string if unassigned
}
*/

const VALID_STATUSES = ['New', 'Active', 'Completed'];

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
        assigned: task.assigned || ''
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
                assigned: ''
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
                            console.error('Error deleting message:', e);
                        }
                    }
                }
            } else {
                // Use bulk delete for recent messages
                await message.channel.bulkDelete(messagesToDelete);
            }
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
    const completedTasks = tasksData.tasks.filter(task => 
        task && task.status === 'Completed'
    );

    const completedTaskHeaders = ["ID", "Task Name", "Date", "Completed By"];
    const completedTaskSelectors = [
        (task) => task.id?.toString() || '',
        (task) => task.name || '',
        (task) => new Date(task.created).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        }),
        (task) => users.getDisplayName(task.assigned, guildId)
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

async function processTaskAction(interaction, action) {
    const input = interaction.options.getString('tasks');
    await interaction.deferReply({ ephemeral: true });
    
    try {
        const tasksData = loadTasks(interaction.guild.id);
        let processedTasks = [];

        // Check if input contains quotes (task descriptions)
        if (input.includes('"')) {
            const descriptions = input.match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').trim()) || [input];
            if (!descriptions.length) {
                throw new Error('Invalid task description format. Use "task name" for descriptions.');
            }

            // Create and process new tasks
            descriptions.forEach(description => {
                if (!description.trim()) return;
                
                const newTask = {
                    id: getNextTaskId(tasksData),
                    name: description,
                    created: new Date().toISOString(),
                    status: action.newStatus,
                    assigned: action.assignUser ? interaction.user.id : ''
                };
                tasksData.tasks.push(newTask);
                processedTasks.push(newTask);
            });

            await interaction.editReply({ 
                content: `Created and ${action.verb} ${processedTasks.length} task(s):\n${processedTasks.map(t => `#${t.id}: ${t.name}`).join('\n')}` 
            });
        } else {
            // Handle task IDs
            const taskIds = input.split(',')
                .map(id => id.trim())
                .filter(id => !isNaN(id))
                .map(id => parseInt(id));

            if (taskIds.length === 0) {
                throw new Error('No valid task IDs provided.');
            }

            // Filter for existing tasks only
            const existingTasks = [];
            const notFoundIds = [];
            
            taskIds.forEach(id => {
                const task = tasksData.tasks.find(t => t.id === id);
                if (task) {
                    existingTasks.push(task);
                } else {
                    notFoundIds.push(id);
                }
            });

            if (existingTasks.length === 0) {
                throw new Error('None of the provided task IDs exist.');
            }

            // Process existing tasks
            existingTasks.forEach(task => {
                task.status = action.newStatus;
                if (action.assignUser) {
                    task.assigned = interaction.user.id;
                }
                processedTasks.push(task);
            });

            let response = `${action.verb} ${processedTasks.length} task(s):\n${processedTasks.map(t => `#${t.id}: ${t.name}`).join('\n')}`;
            if (notFoundIds.length > 0) {
                response += `\n\nNote: Could not find tasks with IDs: ${notFoundIds.join(', ')}`;
            }

            await interaction.editReply({ content: response });
        }
        
        helper.saveTasks(interaction.guild.id, tasksData);
        await displayTaskList(createMessageProxy(interaction), interaction.guild.id);
    } catch (error) {
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
    const guildId = interaction.guild.id;

    try {
        switch (interaction.commandName) {
            case 'done':
            case 'take': {
                await processTaskAction(interaction, {
                    verb: interaction.commandName === 'done' ? 'completed' : 'taken',
                    newStatus: interaction.commandName === 'done' ? 'Completed' : 'Active',
                    assignUser: true
                });
                break;
            }

            case 'task': {
                const input = interaction.options.getString('description');
                if (!input) {
                    throw new Error('No task description provided');
                }

                await interaction.deferReply({ ephemeral: true });
                
                try {
                    console.log('Raw input:', input); // Debug log
                    const tasksData = loadTasks(interaction.guild.id);
                    
                    // Clean up input and handle multiple tasks
                    const cleanInput = input.replace(/^description:\s*/, '').trim();
                    console.log('Cleaned input:', cleanInput); // Debug log
                    
                    const descriptions = cleanInput.includes('"') 
                        ? cleanInput.match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').trim()) || [cleanInput]
                        : [cleanInput];
                    
                    console.log('Parsed descriptions:', descriptions); // Debug log
                    
                    const addedTasks = [];

                    descriptions.forEach(description => {
                        if (!description.trim()) return;

                        const newTask = {
                            id: getNextTaskId(tasksData),
                            name: description,
                            created: new Date().toISOString(),
                            status: 'New',
                            assigned: ''
                        };
                        tasksData.tasks.push(newTask);
                        addedTasks.push(newTask);
                    });
                    
                    helper.saveTasks(interaction.guild.id, tasksData);
                    
                    await interaction.editReply({ 
                        content: `Added ${addedTasks.length} task(s):\n${addedTasks.map(t => `#${t.id}: ${t.name}`).join('\n')}` 
                    });
                    
                    await displayTaskList(createMessageProxy(interaction), interaction.guild.id);
                } catch (error) {
                    await interaction.editReply({ 
                        content: `Error: ${error.message}` 
                    });
                }
                break;
            }

            case 'delete': {
                const input = interaction.options.getString('tasks');
                await interaction.deferReply({ ephemeral: true });
                
                try {
                    const tasksData = loadTasks(interaction.guild.id);
                    const taskIds = input.split(',')
                        .map(id => id.trim())
                        .filter(id => !isNaN(id))
                        .map(id => parseInt(id));

                    if (taskIds.length === 0) {
                        throw new Error('No valid task IDs provided.');
                    }

                    const tasksToDelete = helper.getTasksByIds(taskIds, tasksData);
                    tasksData.tasks = tasksData.tasks.filter(task => !taskIds.includes(task.id));
                    
                    helper.saveTasks(interaction.guild.id, tasksData);
                    
                    await interaction.editReply({ 
                        content: `Deleted ${tasksToDelete.length} task(s):\n${tasksToDelete.map(t => `#${t.id}: ${t.name}`).join('\n')}` 
                    });
                    
                    await displayTaskList(createMessageProxy(interaction), interaction.guild.id);
                } catch (error) {
                    await interaction.editReply({ 
                        content: `Error: ${error.message}` 
                    });
                }
                break;
            }
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

module.exports = { 
    handleSlashCommand,
    loadTasks,
    validateTask
};