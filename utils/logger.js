/**
 * Comprehensive logging utility for ArchiveBot
 * Provides consistent, structured logging with timestamps and result states
 */

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// Current log level (can be configured via environment variable)
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Format timestamp for log entries
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
    return new Date().toISOString();
}

/**
 * Format a log message with consistent structure
 * @param {string} level - Log level
 * @param {string} module - Module name
 * @param {string} action - Action being performed
 * @param {string} status - Result status (SUCCESS, FAILED, etc.)
 * @param {Object} details - Additional details
 * @returns {string} Formatted log message
 */
function formatLog(level, module, action, status, details = {}) {
    const base = {
        timestamp: getTimestamp(),
        level,
        module,
        action,
        status
    };

    // Add non-empty details
    if (Object.keys(details).length > 0) {
        Object.assign(base, details);
    }

    return JSON.stringify(base);
}

/**
 * Log a debug message
 * @param {string} module - Module name
 * @param {string} action - Action being performed
 * @param {Object} details - Additional details
 */
function debug(module, action, details = {}) {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
        console.log(formatLog('DEBUG', module, action, 'DEBUG', details));
    }
}

/**
 * Log an info message
 * @param {string} module - Module name
 * @param {string} action - Action being performed
 * @param {Object} details - Additional details
 */
function info(module, action, details = {}) {
    if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(formatLog('INFO', module, action, 'INFO', details));
    }
}

/**
 * Log a success message
 * @param {string} module - Module name
 * @param {string} action - Action completed
 * @param {Object} details - Additional details
 */
function success(module, action, details = {}) {
    if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(formatLog('INFO', module, action, 'SUCCESS', details));
    }
}

/**
 * Log a failure message
 * @param {string} module - Module name
 * @param {string} action - Action that failed
 * @param {Object} details - Additional details (should include error info)
 */
function fail(module, action, details = {}) {
    if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(formatLog('INFO', module, action, 'FAILED', details));
    }
}

/**
 * Log a warning message
 * @param {string} module - Module name
 * @param {string} action - Action being performed
 * @param {Object} details - Additional details
 */
function warn(module, action, details = {}) {
    if (currentLevel <= LOG_LEVELS.WARN) {
        console.warn(formatLog('WARN', module, action, 'WARNING', details));
    }
}

/**
 * Log an error message
 * @param {string} module - Module name
 * @param {string} action - Action that caused error
 * @param {Error|string} error - Error object or message
 * @param {Object} details - Additional details
 */
function error(module, action, error, details = {}) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
        const errorDetails = {
            ...details,
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined
        };
        console.error(formatLog('ERROR', module, action, 'ERROR', errorDetails));
    }
}

/**
 * Create a scoped logger for a specific module
 * @param {string} moduleName - Module name to scope to
 * @returns {Object} Scoped logger functions
 */
function createLogger(moduleName) {
    return {
        debug: (action, details) => debug(moduleName, action, details),
        info: (action, details) => info(moduleName, action, details),
        success: (action, details) => success(moduleName, action, details),
        fail: (action, details) => fail(moduleName, action, details),
        warn: (action, details) => warn(moduleName, action, details),
        error: (action, err, details) => error(moduleName, action, err, details)
    };
}

module.exports = {
    debug,
    info,
    success,
    fail,
    warn,
    error,
    createLogger,
    LOG_LEVELS
};
