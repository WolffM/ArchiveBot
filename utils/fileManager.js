/**
 * File I/O utilities
 */
const fs = require('fs');
const https = require('https');

/**
 * Ensure directory exists, creating it recursively if needed
 * @param {string} dirPath - Path to directory
 */
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Load JSON file with fallback default value
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist
 * @returns {*} Parsed JSON or default value
 */
function loadJsonFile(filePath, defaultValue = {}) {
    return fs.existsSync(filePath) ?
        JSON.parse(fs.readFileSync(filePath)) :
        defaultValue;
}

/**
 * Save data to JSON file with pretty formatting
 * @param {string} filePath - Path to JSON file
 * @param {*} data - Data to save
 */
function saveJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Download file from URL to local path
 * @param {string} url - URL to download from
 * @param {string} filePath - Local path to save file
 * @returns {Promise<void>}
 */
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

/**
 * Recursively remove empty/null fields and Discord-specific clutter from objects
 * @param {*} obj - Object to clean
 * @param {WeakSet} seen - Set of seen objects for circular reference handling
 * @returns {*} Cleaned object or undefined
 */
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

/**
 * Delay execution for specified milliseconds
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log progress at specified intervals
 * @param {string} label - Label for the log message
 * @param {number} current - Current count
 * @param {number} total - Total count
 * @param {number} interval - Interval at which to log (default 50)
 */
function logProgress(label, current, total, interval = 50) {
    if (current % interval === 0) {
        console.log(`[${label}] ${current} processed, ${total} total.`);
    }
}

module.exports = {
    ensureDirectoryExists,
    loadJsonFile,
    saveJsonFile,
    downloadFile,
    scrubEmptyFields,
    delay,
    logProgress
};
