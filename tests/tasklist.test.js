/**
 * Unit tests for tasklist.js
 * Tests task management logic
 */

// Mock dependencies before requiring the module
jest.mock('fs');
jest.mock('../users', () => ({
    getGuildPath: jest.fn(() => './Output/tasklist/test-guild'),
    getDisplayName: jest.fn((userId) => `User_${userId}`)
}));
jest.mock('../helper', () => ({
    ensureDirectoryExists: jest.fn(),
    splitMessage: jest.fn((content) => [content]),
    calculateAge: jest.fn(() => '1d'),
    saveTasks: jest.fn()
}));
jest.mock('../permissions', () => ({
    checkTaskAccessWithRoles: jest.fn().mockResolvedValue(true)
}));

const fs = require('fs');
const { createMockTasksData } = require('./mocks/filesystem');

const tasklist = require('../tasklist');

describe('tasklist.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
    });

    describe('loadTasks', () => {
        test('loads tasks from file when file exists', () => {
            const mockTasks = createMockTasksData([
                { id: 1, name: 'Task 1', status: 'New' },
                { id: 2, name: 'Task 2', status: 'Active' }
            ]);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(mockTasks));

            const result = tasklist.loadTasks('guild-123');

            expect(result.tasks).toHaveLength(2);
            expect(result.tasks[0].name).toBe('Task 1');
        });

        test('creates initial tasks file when not exists', () => {
            fs.existsSync.mockReturnValue(false);
            fs.writeFileSync.mockImplementation(() => {});

            const result = tasklist.loadTasks('guild-123');

            expect(result.tasks).toEqual([]);
            expect(fs.writeFileSync).toHaveBeenCalled();
        });

        test('returns empty tasks array for new guild', () => {
            fs.existsSync.mockReturnValue(false);
            fs.writeFileSync.mockImplementation(() => {});

            const result = tasklist.loadTasks('new-guild');

            expect(result).toEqual({ tasks: [] });
        });
    });

    describe('getNextTaskId', () => {
        test('returns 1 for empty tasks array', () => {
            const tasksData = { tasks: [] };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1);
        });

        test('returns 1 for undefined tasks', () => {
            const tasksData = {};
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1);
        });

        test('returns 1 for null tasks', () => {
            const tasksData = { tasks: null };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1);
        });

        test('returns max id + 1 for sequential tasks', () => {
            const tasksData = createMockTasksData([
                { id: 1 },
                { id: 2 },
                { id: 3 }
            ]);
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(4);
        });

        test('handles gaps in IDs', () => {
            const tasksData = createMockTasksData([
                { id: 1 },
                { id: 5 },
                { id: 3 }
            ]);
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(6);
        });

        test('filters NaN values', () => {
            const tasksData = {
                tasks: [
                    { id: 1 },
                    { id: 'invalid' },
                    { id: 3 }
                ]
            };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(4);
        });

        test('handles all invalid IDs', () => {
            const tasksData = {
                tasks: [
                    { id: 'a' },
                    { id: 'b' },
                    { id: undefined }
                ]
            };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1);
        });

        test('handles large task IDs', () => {
            const tasksData = {
                tasks: [
                    { id: 1000 },
                    { id: 500 }
                ]
            };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1001);
        });

        test('handles negative IDs correctly', () => {
            const tasksData = {
                tasks: [
                    { id: -5 },
                    { id: 3 }
                ]
            };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(4);
        });

        test('handles zero ID correctly', () => {
            const tasksData = {
                tasks: [
                    { id: 0 }
                ]
            };
            const result = tasklist.getNextTaskId(tasksData);
            expect(result).toBe(1);
        });
    });
});
