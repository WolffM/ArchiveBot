/**
 * Mock utilities for filesystem operations
 * Allows testing file I/O without touching real files
 */

/**
 * Creates an in-memory file system mock
 */
function createMockFileSystem() {
    const files = new Map();
    const directories = new Set();

    return {
        // Track all files
        files,
        directories,

        // Mock fs.existsSync
        existsSync: jest.fn((filePath) => {
            return files.has(filePath) || directories.has(filePath);
        }),

        // Mock fs.readFileSync
        readFileSync: jest.fn((filePath, encoding) => {
            if (!files.has(filePath)) {
                const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
                error.code = 'ENOENT';
                throw error;
            }
            return files.get(filePath);
        }),

        // Mock fs.writeFileSync
        writeFileSync: jest.fn((filePath, content) => {
            files.set(filePath, content);
        }),

        // Mock fs.mkdirSync
        mkdirSync: jest.fn((dirPath, options) => {
            directories.add(dirPath);
            if (options?.recursive) {
                // Add all parent directories
                const parts = dirPath.split(/[/\\]/);
                let currentPath = '';
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    directories.add(currentPath);
                });
            }
        }),

        // Mock fs.readdirSync
        readdirSync: jest.fn((dirPath) => {
            const result = [];
            for (const filePath of files.keys()) {
                if (filePath.startsWith(dirPath)) {
                    const relativePath = filePath.slice(dirPath.length + 1);
                    const firstSegment = relativePath.split(/[/\\]/)[0];
                    if (firstSegment && !result.includes(firstSegment)) {
                        result.push(firstSegment);
                    }
                }
            }
            return result;
        }),

        // Mock fs.appendFileSync
        appendFileSync: jest.fn((filePath, content) => {
            const existing = files.get(filePath) || '';
            files.set(filePath, existing + content);
        }),

        // Mock fs.unlinkSync
        unlinkSync: jest.fn((filePath) => {
            files.delete(filePath);
        }),

        // Helper to set up test files
        setFile: (filePath, content) => {
            files.set(filePath, typeof content === 'string' ? content : JSON.stringify(content));
        },

        // Helper to clear all files
        clear: () => {
            files.clear();
            directories.clear();
        }
    };
}

/**
 * Creates mock tasks data structure
 */
function createMockTasksData(tasks = []) {
    return {
        tasks: tasks.map((task, index) => ({
            id: task.id || index + 1,
            name: task.name || `Task ${index + 1}`,
            createdDate: task.createdDate || new Date().toISOString(),
            status: task.status || 'New',
            assigned: task.assigned || '',
            category: task.category || '',
            ...task
        }))
    };
}

/**
 * Creates mock permissions data structure
 */
function createMockPermissions(overrides = {}) {
    return {
        adminUsers: [],
        taskUsers: [],
        lastUpdated: new Date().toISOString(),
        ...overrides
    };
}

/**
 * Creates mock color roles data structure
 */
function createMockColorRoles(roles = []) {
    return {
        roles: roles.map((role, index) => ({
            id: role.id || `role-${index}`,
            name: role.name || `Color ${index}`,
            hexColor: role.hexColor || '#FF0000',
            ...role
        }))
    };
}

module.exports = {
    createMockFileSystem,
    createMockTasksData,
    createMockPermissions,
    createMockColorRoles
};
