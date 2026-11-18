/**
 * The canonical permission list: what is on it, the bitfield the invite and
 * re-authorise links carry, and the check that names what is missing.
 */

const { PermissionsBitField } = require('discord.js');
const {
    BOT_PERMISSIONS,
    permissionBits,
    missingPermissions,
    inviteUrl,
    reauthorizeUrl,
} = require('../lib/botPermissions');

const names = BOT_PERMISSIONS.map((p) => p.name);

function memberWith(granted) {
    const set = new Set(granted.map((n) => PermissionsBitField.Flags[n]));
    return { permissions: { has: (flag) => set.has(flag) } };
}

describe('BOT_PERMISSIONS', () => {
    test('every entry is a real Discord permission with a label and a reason', () => {
        for (const p of BOT_PERMISSIONS) {
            expect(PermissionsBitField.Flags[p.name]).toEqual(expect.any(BigInt));
            expect(p.label).toEqual(expect.any(String));
            expect(p.why).toEqual(expect.any(String));
        }
        expect(new Set(names).size).toBe(names.length);
    });

    test('carries the events permissions the Events tab needs', () => {
        expect(names).toEqual(expect.arrayContaining(['CreateEvents', 'ManageEvents']));
    });

    test("carries what /setup layout:cardtable has always checked", () => {
        expect(names).toEqual(
            expect.arrayContaining([
                'ManageChannels',
                'ManageRoles',
                'CreateInstantInvite',
                'ManageGuild',
                'ViewChannel',
                'SendMessages',
                'EmbedLinks',
                'ManageNicknames',
            ])
        );
    });

    test('never Administrator', () => {
        expect(names).not.toContain('Administrator');
        expect(permissionBits() & PermissionsBitField.Flags.Administrator).toBe(0n);
    });
});

describe('permissionBits', () => {
    test('is the OR of every flag on the list', () => {
        const expected = names.reduce((bits, n) => bits | PermissionsBitField.Flags[n], 0n);
        expect(permissionBits()).toBe(expected);
        expect(new PermissionsBitField(permissionBits()).toArray().sort()).toEqual([...names].sort());
    });

    // Pinned so a change to the list is a deliberate edit here too: this is
    // the number every invite and re-authorise link carries.
    test('is 17876059942003', () => {
        expect(permissionBits()).toBe(17876059942003n);
    });
});

describe('missingPermissions', () => {
    test('reports exactly the entries the member lacks, in list order', () => {
        const granted = names.filter((n) => n !== 'CreateEvents' && n !== 'ManageEvents');
        expect(missingPermissions(memberWith(granted)).map((p) => p.name)).toEqual(['CreateEvents', 'ManageEvents']);
    });

    test('is empty when everything is granted', () => {
        expect(missingPermissions(memberWith(names))).toEqual([]);
    });
});

describe('authorise links', () => {
    test('the re-authorise link targets the guild and carries the whole bitfield', () => {
        const url = new URL(reauthorizeUrl('1313904906150744074', '1563307288406786078'));
        expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
        expect(url.searchParams.get('client_id')).toBe('1313904906150744074');
        expect(url.searchParams.get('scope')).toBe('bot applications.commands');
        expect(url.searchParams.get('permissions')).toBe(permissionBits().toString());
        expect(url.searchParams.get('guild_id')).toBe('1563307288406786078');
        expect(url.searchParams.get('disable_guild_select')).toBe('true');
    });

    test('the invite link carries the same bitfield and no guild', () => {
        const url = new URL(inviteUrl('1313904906150744074'));
        expect(url.searchParams.get('permissions')).toBe(permissionBits().toString());
        expect(url.searchParams.has('guild_id')).toBe(false);
    });

    test('no application id, no link', () => {
        expect(reauthorizeUrl(undefined, '1')).toBeNull();
    });
});
