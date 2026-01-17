/**
 * Unit tests for colorroles.js
 * Tests color role logic without Discord API calls
 */

// Mock fs and discord.js before requiring the module
jest.mock('fs');
jest.mock('discord.js', () => ({
    PermissionsBitField: { Flags: { ManageRoles: 'MANAGE_ROLES' } },
    AttachmentBuilder: jest.fn()
}));
jest.mock('../utils/helper', () => ({
    ensureDirectoryExists: jest.fn()
}));

const { createMockColorRoles } = require('./mocks/filesystem');
const colorroles = require('../lib/colorroles');

describe('colorroles.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('findColorRole', () => {
        const colorRoles = createMockColorRoles([
            { id: 'role-1', name: 'Red', hexColor: '#FF0000' },
            { id: 'role-2', name: 'Blue', hexColor: '#0000FF' },
            { id: 'role-3', name: 'SeaGreen', hexColor: '#2E8B57' }
        ]);

        test('finds role by exact ID', () => {
            const result = colorroles.findColorRole(colorRoles, 'role-1');
            expect(result).not.toBeNull();
            expect(result.name).toBe('Red');
        });

        test('finds role by name (case insensitive)', () => {
            const result = colorroles.findColorRole(colorRoles, 'red');
            expect(result).not.toBeNull();
            expect(result.id).toBe('role-1');
        });

        test('finds role by name with different case', () => {
            const result = colorroles.findColorRole(colorRoles, 'SEAGREEN');
            expect(result).not.toBeNull();
            expect(result.hexColor).toBe('#2E8B57');
        });

        test('finds role by hex color (exact match)', () => {
            const result = colorroles.findColorRole(colorRoles, '#FF0000');
            expect(result).not.toBeNull();
            expect(result.name).toBe('Red');
        });

        test('finds role by hex color (lowercase)', () => {
            const result = colorroles.findColorRole(colorRoles, '#ff0000');
            expect(result).not.toBeNull();
            expect(result.name).toBe('Red');
        });

        test('returns formatted hex for valid hex input not in roles', () => {
            const result = colorroles.findColorRole(colorRoles, '#ABCDEF');
            expect(result).not.toBeNull();
            expect(result.hexColor).toBe('#ABCDEF');
            expect(result.id).toBeNull();
            expect(result.name).toBeNull();
        });

        test('handles hex without # prefix', () => {
            const result = colorroles.findColorRole(colorRoles, 'ABCDEF');
            expect(result).not.toBeNull();
            expect(result.hexColor).toBe('#ABCDEF');
        });

        test('handles 3-character hex codes', () => {
            const result = colorroles.findColorRole(colorRoles, '#ABC');
            expect(result).not.toBeNull();
            expect(result.hexColor).toBe('#ABC');
        });

        test('returns null for null identifier', () => {
            const result = colorroles.findColorRole(colorRoles, null);
            expect(result).toBeNull();
        });

        test('returns null for empty identifier', () => {
            const result = colorroles.findColorRole(colorRoles, '');
            expect(result).toBeNull();
        });

        test('returns null for invalid identifier', () => {
            const result = colorroles.findColorRole(colorRoles, 'nonexistent');
            expect(result).toBeNull();
        });

        test('returns null for invalid hex format', () => {
            const result = colorroles.findColorRole(colorRoles, '#GGG');
            expect(result).toBeNull();
        });
    });

    describe('hexToHSL', () => {
        test('converts pure red correctly', () => {
            const result = colorroles.hexToHSL('#FF0000');
            expect(result.h).toBeCloseTo(0, 1);
            expect(result.s).toBeCloseTo(1, 1);
            expect(result.l).toBeCloseTo(0.5, 1);
        });

        test('converts pure green correctly', () => {
            const result = colorroles.hexToHSL('#00FF00');
            expect(result.h).toBeCloseTo(0.333, 1);
            expect(result.s).toBeCloseTo(1, 1);
            expect(result.l).toBeCloseTo(0.5, 1);
        });

        test('converts pure blue correctly', () => {
            const result = colorroles.hexToHSL('#0000FF');
            expect(result.h).toBeCloseTo(0.667, 1);
            expect(result.s).toBeCloseTo(1, 1);
            expect(result.l).toBeCloseTo(0.5, 1);
        });

        test('converts black correctly', () => {
            const result = colorroles.hexToHSL('#000000');
            expect(result.l).toBe(0);
        });

        test('converts white correctly', () => {
            const result = colorroles.hexToHSL('#FFFFFF');
            expect(result.l).toBe(1);
        });

        test('handles gray (achromatic)', () => {
            const result = colorroles.hexToHSL('#808080');
            expect(result.h).toBe(0);
            expect(result.s).toBe(0);
        });
    });

    describe('sortColorsByHSL', () => {
        test('sorts colors by hue', () => {
            const colors = [
                { hexColor: '#0000FF' }, // Blue (hue ~0.67)
                { hexColor: '#FF0000' }, // Red (hue 0)
                { hexColor: '#00FF00' }  // Green (hue ~0.33)
            ];
            const sorted = colorroles.sortColorsByHSL(colors);
            // Red (hue 0) should come first
            expect(sorted[0].hexColor).toBe('#FF0000');
        });

        test('does not mutate original array', () => {
            const colors = [
                { hexColor: '#0000FF' },
                { hexColor: '#FF0000' }
            ];
            const sorted = colorroles.sortColorsByHSL(colors);
            expect(sorted).not.toBe(colors);
        });

        test('handles empty array', () => {
            const sorted = colorroles.sortColorsByHSL([]);
            expect(sorted).toEqual([]);
        });

        test('handles single color', () => {
            const colors = [{ hexColor: '#FF0000' }];
            const sorted = colorroles.sortColorsByHSL(colors);
            expect(sorted).toHaveLength(1);
        });
    });

    describe('getFriendlyColorName', () => {
        test('returns name for known color Red', () => {
            expect(colorroles.getFriendlyColorName('#FF0000')).toBe('Red');
        });

        test('returns name for known color Blue', () => {
            expect(colorroles.getFriendlyColorName('#0000FF')).toBe('Blue');
        });

        test('returns name for known color Green', () => {
            expect(colorroles.getFriendlyColorName('#00FF00')).toBe('Green');
        });

        test('returns null for unknown color', () => {
            expect(colorroles.getFriendlyColorName('#123456')).toBeNull();
        });

        test('handles hex without # prefix', () => {
            expect(colorroles.getFriendlyColorName('FF0000')).toBe('Red');
        });

        test('handles lowercase hex', () => {
            expect(colorroles.getFriendlyColorName('#ff0000')).toBe('Red');
        });
    });
});
