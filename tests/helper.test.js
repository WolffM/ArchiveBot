/**
 * Unit tests for helper.js
 * Tests pure functions without Discord API calls
 */

// Mock fs before requiring helper
jest.mock('fs');
jest.mock('./users', () => ({
    getGuildPath: jest.fn(() => './Output/tasklist/test-guild'),
    getDisplayName: jest.fn((userId) => `User_${userId}`)
}), { virtual: true });

const fs = require('fs');
const { createMockTasksData } = require('./mocks/filesystem');

// Import helper functions
const helper = require('../helper');

describe('helper.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('parseTaskIds', () => {
        test('parses valid task IDs from args array', () => {
            const args = ['ignored', '1', '2', '3'];
            const result = helper.parseTaskIds(args);
            expect(result).toEqual([1, 2, 3]);
        });

        test('filters out NaN values', () => {
            const args = ['ignored', '1', 'abc', '3', 'def'];
            const result = helper.parseTaskIds(args);
            expect(result).toEqual([1, 3]);
        });

        test('returns empty array when no valid IDs', () => {
            const args = ['ignored', 'abc', 'def'];
            const result = helper.parseTaskIds(args);
            expect(result).toEqual([]);
        });

        test('handles empty args after first element', () => {
            const args = ['ignored'];
            const result = helper.parseTaskIds(args);
            expect(result).toEqual([]);
        });
    });

    describe('truncateString', () => {
        test('returns original string if under max length', () => {
            const result = helper.truncateString('hello', 10);
            expect(result).toBe('hello');
        });

        test('returns original string if exactly max length', () => {
            const result = helper.truncateString('hello', 5);
            expect(result).toBe('hello');
        });

        test('truncates and adds ellipsis if over max length', () => {
            const result = helper.truncateString('hello world', 8);
            expect(result).toBe('hello...');
            expect(result.length).toBe(8);
        });

        test('handles very short max length', () => {
            const result = helper.truncateString('hello', 4);
            expect(result).toBe('h...');
        });
    });

    describe('splitMessage', () => {
        test('returns single chunk for short content', () => {
            const result = helper.splitMessage('short message');
            expect(result).toHaveLength(1);
            expect(result[0]).toContain('short message');
        });

        test('splits content at newlines', () => {
            const lines = Array(50).fill('line').join('\n');
            const result = helper.splitMessage(lines, 100);
            expect(result.length).toBeGreaterThan(1);
        });

        test('respects custom limit', () => {
            const content = 'line1\nline2\nline3';
            const result = helper.splitMessage(content, 10);
            result.forEach(chunk => {
                expect(chunk.length).toBeLessThanOrEqual(11); // +1 for trailing newline
            });
        });

        test('handles empty content', () => {
            const result = helper.splitMessage('');
            // Note: The function returns ['\n'] for empty input due to trailing newline logic
            // This could be considered a bug, but we test actual behavior
            expect(result).toHaveLength(1);
            expect(result[0]).toBe('\n');
        });
    });

    describe('calculateAge', () => {
        test('returns 1d for today', () => {
            const today = new Date().toISOString();
            const result = helper.calculateAge(today);
            expect(result).toBe('1d');
        });

        test('returns correct days for older dates', () => {
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
            const result = helper.calculateAge(threeDaysAgo.toISOString());
            expect(result).toMatch(/[34]d/); // Could be 3d or 4d depending on time
        });
    });

    describe('getYear', () => {
        test('extracts year from timestamp', () => {
            const timestamp = new Date('2024-06-15').getTime();
            const result = helper.getYear(timestamp);
            expect(result).toBe('2024');
        });

        test('handles string date', () => {
            const result = helper.getYear('2023-01-01');
            expect(result).toBe('2023');
        });
    });

    describe('getMonthYear', () => {
        test('formats timestamp as YYYY-MM', () => {
            const timestamp = new Date('2024-06-15').getTime();
            const result = helper.getMonthYear(timestamp);
            expect(result).toBe('2024-06');
        });

        test('pads single digit months', () => {
            const timestamp = new Date('2024-01-15').getTime();
            const result = helper.getMonthYear(timestamp);
            expect(result).toBe('2024-01');
        });
    });

    describe('getTasksByIds', () => {
        test('returns matching tasks', () => {
            const tasksData = createMockTasksData([
                { id: 1, name: 'Task 1' },
                { id: 2, name: 'Task 2' },
                { id: 3, name: 'Task 3' }
            ]);
            const result = helper.getTasksByIds([1, 3], tasksData);
            expect(result).toHaveLength(2);
            expect(result.map(t => t.id)).toEqual([1, 3]);
        });

        test('returns empty array when no matches', () => {
            const tasksData = createMockTasksData([{ id: 1 }]);
            const result = helper.getTasksByIds([99], tasksData);
            expect(result).toEqual([]);
        });
    });

    describe('getTasksByStatus', () => {
        test('returns tasks with matching status', () => {
            const tasksData = createMockTasksData([
                { id: 1, status: 'New' },
                { id: 2, status: 'Active' },
                { id: 3, status: 'New' }
            ]);
            const result = helper.getTasksByStatus('New', tasksData);
            expect(result).toHaveLength(2);
        });

        test('throws error when no tasks found', () => {
            const tasksData = createMockTasksData([{ id: 1, status: 'Active' }]);
            expect(() => {
                helper.getTasksByStatus('Completed', tasksData);
            }).toThrow('No matching tasks found');
        });
    });

    describe('updateTaskStatus', () => {
        test('updates task status', () => {
            const task = { id: 1, status: 'New', assigned: '' };
            const result = helper.updateTaskStatus(task, 'Active');
            expect(result.status).toBe('Active');
        });

        test('assigns user if unassigned and userId provided', () => {
            const task = { id: 1, status: 'New', assigned: '' };
            const result = helper.updateTaskStatus(task, 'Active', 'user-123');
            expect(result.assigned).toBe('user-123');
        });

        test('does not overwrite existing assignment', () => {
            const task = { id: 1, status: 'New', assigned: 'existing-user' };
            const result = helper.updateTaskStatus(task, 'Active', 'new-user');
            expect(result.assigned).toBe('existing-user');
        });
    });

    describe('assignTask', () => {
        test('assigns user and sets status to Active', () => {
            const task = { id: 1, status: 'New', assigned: '' };
            const result = helper.assignTask(task, 'user-123');
            expect(result.assigned).toBe('user-123');
            expect(result.status).toBe('Active');
        });
    });

    describe('formatTasks', () => {
        test('formats tasks as string list', () => {
            const tasks = [
                { id: 1, name: 'First task' },
                { id: 2, name: 'Second task' }
            ];
            const result = helper.formatTasks(tasks);
            expect(result).toBe('[1] First task\n[2] Second task');
        });

        test('handles empty array', () => {
            const result = helper.formatTasks([]);
            expect(result).toBe('');
        });
    });

    describe('validateTaskIds', () => {
        test('returns valid task IDs', () => {
            const tasksData = createMockTasksData([
                { id: 1 },
                { id: 2 },
                { id: 3 }
            ]);
            const result = helper.validateTaskIds([1, 2, 99], tasksData);
            expect(result).toEqual([1, 2]);
        });

        test('throws error when no valid IDs', () => {
            const tasksData = createMockTasksData([{ id: 1 }]);
            expect(() => {
                helper.validateTaskIds([99, 100], tasksData);
            }).toThrow('No valid task IDs provided');
        });
    });

    describe('scrubEmptyFields', () => {
        test('removes null and undefined values', () => {
            const obj = { a: 1, b: null, c: undefined, d: 'hello' };
            const result = helper.scrubEmptyFields(obj);
            expect(result).toEqual({ a: 1, d: 'hello' });
        });

        test('removes false values', () => {
            const obj = { a: true, b: false, c: 'test' };
            const result = helper.scrubEmptyFields(obj);
            expect(result).toEqual({ a: true, c: 'test' });
        });

        test('removes specific Discord fields', () => {
            const obj = {
                id: '123',
                discriminator: '0001',
                avatar: 'abc',
                content: 'message'
            };
            const result = helper.scrubEmptyFields(obj);
            expect(result.discriminator).toBeUndefined();
            expect(result.avatar).toBeUndefined();
            expect(result.id).toBe('123');
            expect(result.content).toBe('message');
        });

        test('handles nested objects', () => {
            const obj = {
                outer: {
                    inner: 'value',
                    empty: null
                }
            };
            const result = helper.scrubEmptyFields(obj);
            expect(result.outer.inner).toBe('value');
            expect(result.outer.empty).toBeUndefined();
        });

        test('handles circular references', () => {
            const obj = { a: 1 };
            obj.self = obj;
            // Should not throw
            const result = helper.scrubEmptyFields(obj);
            expect(result.a).toBe(1);
        });

        test('returns undefined for empty object', () => {
            const obj = { a: null, b: undefined };
            const result = helper.scrubEmptyFields(obj);
            expect(result).toBeUndefined();
        });
    });

    describe('delay', () => {
        test('returns a promise', () => {
            const result = helper.delay(0);
            expect(result).toBeInstanceOf(Promise);
        });

        test('resolves after specified time', async () => {
            const start = Date.now();
            await helper.delay(50);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
        });
    });

    describe('logProgress', () => {
        test('logs at specified interval', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            helper.logProgress('Test', 50, 100, 50);
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        test('does not log between intervals', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            helper.logProgress('Test', 25, 100, 50);
            expect(consoleSpy).not.toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });
});
