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

function getTasksByIds(taskIds, tasksData) {
    const tasks = tasksData.tasks.filter((task) => taskIds.includes(task.taskId));
    if (tasks.length === 0) {
        throw new Error('No matching tasks found for the provided IDs.');
    }
    return tasks;
}

function updateTaskStatus(task, status, userId = null) {
    if (userId && (!task.assignedTo || task.assignedTo.trim() === '')) {
        task.assignedTo = userId; // Assign if unassigned
    }
    task.status = status;
    return task;
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
    task.assignedTo = userId;
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

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
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