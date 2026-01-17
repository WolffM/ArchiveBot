/**
 * Unit tests for permissions.js
 * Tests permission checking logic
 */

// Mock fs before requiring the module
jest.mock('fs');
jest.mock('../utils/helper', () => ({
    ensureDirectoryExists: jest.fn()
}));

const fs = require('fs');
const { createMockPermissions } = require('./mocks/filesystem');
const { createMockMember, createMockGuild } = require('./mocks/discord');

const permissions = require('../lib/permissions');

describe('permissions.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: file exists with empty permissions
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(createMockPermissions()));
        fs.writeFileSync.mockImplementation(() => {});
    });

    describe('isAdmin', () => {
        test('returns true when user is in adminUsers list', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['user-123', 'user-456']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.isAdmin('user-123', 'guild-1');
            expect(result).toBe(true);
        });

        test('returns false when user is not in adminUsers list', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['user-123']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.isAdmin('user-999', 'guild-1');
            expect(result).toBe(false);
        });

        test('returns false when adminUsers is empty', () => {
            const mockPerms = createMockPermissions({ adminUsers: [] });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.isAdmin('user-123', 'guild-1');
            expect(result).toBe(false);
        });
    });

    describe('hasTaskAccess', () => {
        test('returns true when user is admin', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['user-123'],
                taskUsers: []
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.hasTaskAccess('user-123', 'guild-1');
            expect(result).toBe(true);
        });

        test('returns true when user is in taskUsers list', () => {
            const mockPerms = createMockPermissions({
                adminUsers: [],
                taskUsers: ['user-456']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.hasTaskAccess('user-456', 'guild-1');
            expect(result).toBe(true);
        });

        test('returns false when user has no permissions', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['admin-1'],
                taskUsers: ['task-1']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.hasTaskAccess('user-999', 'guild-1');
            expect(result).toBe(false);
        });
    });

    describe('hasRole', () => {
        test('returns true when member has role', () => {
            const member = createMockMember([
                { id: 'role-1', name: 'Admin' }
            ]);

            const result = permissions.hasRole(member, 'Admin');
            expect(result).toBe(true);
        });

        test('returns true with case-insensitive match', () => {
            const member = createMockMember([
                { id: 'role-1', name: 'Admin' }
            ]);

            const result = permissions.hasRole(member, 'admin');
            expect(result).toBe(true);
        });

        test('returns false when member does not have role', () => {
            const member = createMockMember([
                { id: 'role-1', name: 'User' }
            ]);

            const result = permissions.hasRole(member, 'Admin');
            expect(result).toBe(false);
        });

        test('returns false when member is null', () => {
            const result = permissions.hasRole(null, 'Admin');
            expect(result).toBe(false);
        });

        test('returns false when member.roles is undefined', () => {
            const member = { id: 'member-1' };
            const result = permissions.hasRole(member, 'Admin');
            expect(result).toBe(false);
        });
    });

    describe('getUsersWithPermission', () => {
        test('returns admin users list', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['admin-1', 'admin-2'],
                taskUsers: ['task-1']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.getUsersWithPermission('guild-1', 'admin');
            expect(result).toEqual(['admin-1', 'admin-2']);
        });

        test('returns task users list', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['admin-1'],
                taskUsers: ['task-1', 'task-2']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.getUsersWithPermission('guild-1', 'task');
            expect(result).toEqual(['task-1', 'task-2']);
        });

        test('returns copy of array (not reference)', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['admin-1']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result1 = permissions.getUsersWithPermission('guild-1', 'admin');
            const result2 = permissions.getUsersWithPermission('guild-1', 'admin');
            expect(result1).not.toBe(result2);
        });

        test('throws error for unknown permission type', () => {
            expect(() => {
                permissions.getUsersWithPermission('guild-1', 'unknown');
            }).toThrow('Unknown permission type');
        });
    });

    describe('loadPermissions', () => {
        test('loads permissions from file', () => {
            const mockPerms = createMockPermissions({
                adminUsers: ['admin-1'],
                taskUsers: ['task-1']
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(mockPerms));

            const result = permissions.loadPermissions('guild-1');
            expect(result.adminUsers).toContain('admin-1');
            expect(result.taskUsers).toContain('task-1');
        });

        test('initializes new permissions file if not exists', () => {
            fs.existsSync.mockReturnValue(false);
            fs.writeFileSync.mockImplementation(() => {});

            const result = permissions.loadPermissions('guild-1');
            expect(result.adminUsers).toEqual([]);
            expect(result.taskUsers).toEqual([]);
            expect(fs.writeFileSync).toHaveBeenCalled();
        });
    });
});
