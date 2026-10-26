/**
 * File I/O utilities
 */
const fs = require('fs');
const http = require('http');
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
 *
 * Written to `<filePath>.part` and renamed only once the whole body is on disk,
 * so a failed download never leaves a truncated file where the real one goes.
 * A non-200 response is a failure, not a file: Discord answers an expired or
 * missing attachment with an error body, which used to be saved as the
 * attachment and counted as downloaded.
 *
 * @param {string} url - URL to download from
 * @param {string} filePath - Local path to save file
 * @param {number} [expectedSize] - Byte count to verify, when the caller knows it
 * @returns {Promise<number>} bytes written
 */
function downloadFile(url, filePath, expectedSize) {
    const partPath = `${filePath}.part`;
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve, reject) => {
        const fail = (err) => {
            fs.rm(partPath, { force: true }, () => reject(err));
        };
        client.get(url, response => {
            if (response.statusCode !== 200) {
                response.resume();
                fail(new Error(`HTTP ${response.statusCode} downloading ${filePath}`));
                return;
            }
            const file = fs.createWriteStream(partPath);
            response.on('error', err => file.destroy(err));
            file.on('error', fail);
            file.on('finish', () => {
                const bytes = file.bytesWritten;
                if (expectedSize !== undefined && expectedSize !== null && bytes !== expectedSize) {
                    fail(new Error(`expected ${expectedSize} bytes, got ${bytes} downloading ${filePath}`));
                    return;
                }
                fs.rename(partPath, filePath, err => (err ? fail(err) : resolve(bytes)));
            });
            response.pipe(file);
        }).on('error', fail);
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
