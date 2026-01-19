/**
 * CSV file utilities
 */
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

/**
 * Read log entries from CSV file
 * @param {string} logFilePath - Path to CSV log file
 * @returns {Object[]} Array of log entry records
 */
function readLogEntries(logFilePath) {
    if (!fs.existsSync(logFilePath)) {
        return [];
    }

    const logRaw = fs.readFileSync(logFilePath, 'utf8');
    const lines = logRaw.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return [];

    const headers = lines[0].split(',').map(h => h.trim());
    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < 4) continue;
        const record = {};
        headers.forEach((header, index) => {
            record[header] = row[index];
        });
        records.push(record);
    }
    return records;
}

/**
 * Append a log entry to CSV file
 * @param {string} logFilePath - Path to CSV log file
 * @param {Object} newEntry - Entry to append
 */
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

module.exports = {
    readLogEntries,
    appendLogEntry
};
