const fs = require('fs');
const path = require('path');
const csv = require('csv-parse/sync');

async function fixUnknownUserIds(guildPath, tasksData) {
    console.log('Fixing unknown userIds...');
    const statsPath = path.join(guildPath, 'stats.csv');
    
    if (!fs.existsSync(statsPath)) {
        console.log('No stats.csv found for userId fixing');
        return tasksData;
    }

    const statsContent = fs.readFileSync(statsPath, 'utf8');
    const userIdMap = new Map(); // Map of taskId -> userId from stats

    // Build map of taskId -> userId from stats.csv
    console.log('Reading stats.csv...');
    statsContent.split('\n').slice(1).forEach(line => {
        if (!line.trim()) return;
        
        // Log each line we're processing for debugging
        console.log('Processing line:', line);
        
        const [userId, taskId, taskName, createdDate, modifiedDate, status] = line.split(',');
        if (userId && userId.trim() !== 'unknown' && taskId) {
            userIdMap.set(parseInt(taskId.trim()), userId.trim());
        }
    });

    console.log(`Found ${userIdMap.size} user mappings in stats.csv`);
    console.log('UserIdMap:', Object.fromEntries(userIdMap));

    // Fix unknown userIds in tasks
    let fixedCount = 0;
    tasksData.tasks.forEach(task => {
        const correctUserId = userIdMap.get(task.id);
        console.log(`Checking task ${task.id}: Found userId ${correctUserId}`);

        if (correctUserId) {
            // Fix unknown userIds in history
            task.history.forEach(entry => {
                if (entry.userId === 'unknown') {
                    entry.userId = correctUserId;
                    fixedCount++;
                    console.log(`Fixed history entry for task ${task.id}`);
                }
            });

            // Fix assigned field if it's empty
            if (!task.assigned) {
                task.assigned = correctUserId;
                fixedCount++;
                console.log(`Fixed assigned field for task ${task.id}`);
            }
        }
    });

    console.log(`Fixed ${fixedCount} unknown userIds`);
    return tasksData;
}

async function migrateGuild(guildId) {
    console.log(`Migrating guild: ${guildId}`);
    const guildPath = path.join('Output', 'tasklist', guildId);
    const statsPath = path.join(guildPath, 'stats.csv');
    const tasksPath = path.join(guildPath, 'tasks.json');

    try {
        if (!fs.existsSync(statsPath)) {
            return 'No stats.csv found, skipping...';
        }

        const statsContent = fs.readFileSync(statsPath, 'utf8');
        const records = csv.parse(statsContent, {
            columns: ['userId', 'taskId', 'taskName', 'createdDate', 'modifiedDate', 'status'],
            skip_empty_lines: true,
            from_line: 2
        });

        let tasksData = { tasks: [] };
        if (fs.existsSync(tasksPath)) {
            tasksData = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        }

        for (const record of records) {
            const taskId = parseInt(record.taskId);
            let task = tasksData.tasks.find(t => t.id === taskId);

            // Map "Created" status to "New"
            const status = record.status === 'Created' ? 'New' : record.status;

            if (!task) {
                task = {
                    id: taskId,
                    name: record.taskName,
                    created: record.createdDate,
                    status: status,
                    assigned: record.userId,
                    history: []
                };
                tasksData.tasks.push(task);
            }

            // Clear existing history to prevent duplicates
            task.history = [];

            // Add Created action with the created date, but use "New" as the action
            task.history.push({
                date: record.createdDate,
                action: 'New',  // Change "Created" to "New"
                userId: record.userId
            });

            // Add status change with the modified date
            if (status !== 'New') {  // Only add if it's not the initial "New" status
                task.history.push({
                    date: record.modifiedDate,
                    action: status,
                    userId: record.userId
                });
            }
        }

        // For each task, sort history by date and set status to most recent action
        tasksData.tasks.forEach(task => {
            // Also update any existing "Created" statuses to "New"
            if (task.status === 'Created') {
                task.status = 'New';
            }
            
            task.history.sort((a, b) => new Date(a.date) - new Date(b.date));
            // Update any "Created" actions in history to "New"
            task.history.forEach(entry => {
                if (entry.action === 'Created') {
                    entry.action = 'New';
                }
            });
            
            const lastEntry = task.history[task.history.length - 1];
            task.status = lastEntry.action;
        });

        // Fix any unknown userIds
        tasksData = await fixUnknownUserIds(guildPath, tasksData);

        // Save updated tasks.json
        fs.writeFileSync(tasksPath, JSON.stringify(tasksData, null, 2));
        
        return `Migration complete. Processed ${records.length} records.`;

    } catch (error) {
        console.error('Migration error:', error);
        throw new Error(`Migration failed: ${error.message}`);
    }
}

async function migrateAll() {
    const basePath = './Output/tasklist';
    const guildDirs = fs.readdirSync(basePath)
        .filter(name => fs.statSync(path.join(basePath, name)).isDirectory());
    
    for (const guildDir of guildDirs) {
        await migrateGuild(guildDir);
    }
    console.log('Migration complete!');
}

// Run migration
migrateAll().catch(console.error);

// Only export what we need
module.exports = { migrateGuild }; 