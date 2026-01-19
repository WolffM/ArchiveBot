/**
 * Date formatting utilities
 */

/**
 * Calculate age in days from a date string
 * @param {string} dateString - ISO date string
 * @returns {string} Age in days (e.g., "5d" or "1d")
 */
function calculateAge(dateString) {
    const created = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - created);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 1 ? `${diffDays}d` : '1d';
}

/**
 * Get year from timestamp
 * @param {number|string|Date} ts - Timestamp
 * @returns {string} Year as string
 */
function getYear(ts) {
    return new Date(ts).getUTCFullYear().toString();
}

/**
 * Get year-month from timestamp
 * @param {number|string|Date} ts - Timestamp
 * @returns {string} Year-month as string (e.g., "2025-01")
 */
function getMonthYear(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
    calculateAge,
    getYear,
    getMonthYear
};
