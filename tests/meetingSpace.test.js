/**
 * Meeting space provisioning, invite attribution and expiry.
 *
 * The two things worth testing hard are the ones that fail quietly:
 *
 *   - INVITE ATTRIBUTION decides which stranger gets access to which private
 *     space. A wrong answer here is a privacy breach, not a bug, so the
 *     ambiguous cases must resolve to "no role" rather than to a guess.
 *   - TEARDOWN is load-bearing against Discord's 500-channel / 250-role
 *     ceilings. A space marked inactive while its channels survive is
 *     invisible to every future sweep and charges the ceiling forever.
 */

const { resolveConsumedCode, teardownSpace } = require('../lib/meetingSpaceReaper');
const { validateProvisionPayload, spaceToken, DEFAULT_TTL_MS, MAX_TTL_MS } = require('../lib/meetingSpace');

const envelope = () => ({ idempotencyKey: 'key-1', timestamp: Date.now() });

describe('validateProvisionPayload', () => {
    it('accepts a minimal payload and defaults the TTL to 8 days', () => {
        const r = validateProvisionPayload({ ...envelope(), label: 'Booking 123' });
        expect(r.ok).toBe(true);
        expect(r.value.ttlMs).toBe(DEFAULT_TTL_MS);
        expect(DEFAULT_TTL_MS).toBe(8 * 24 * 60 * 60 * 1000);
    });

    it('rejects a stale timestamp', () => {
        const r = validateProvisionPayload({
            idempotencyKey: 'k',
            timestamp: Date.now() - 20 * 60 * 1000,
            label: 'x',
        });
        expect(r).toEqual({ ok: false, error: 'stale_timestamp' });
    });

    it('rejects a missing idempotency key — a replay would burn 3 channels', () => {
        const r = validateProvisionPayload({ timestamp: Date.now(), label: 'x' });
        expect(r).toEqual({ ok: false, error: 'missing_idempotency_key' });
    });

    it.each([
        ['absent', undefined, 'invalid_label'],
        ['empty', '   ', 'invalid_label'],
    ])('rejects a %s label', (_n, label, error) => {
        const r = validateProvisionPayload({ ...envelope(), label });
        expect(r).toEqual({ ok: false, error });
    });

    it('refuses an absurd TTL rather than parking channels for a year', () => {
        const r = validateProvisionPayload({ ...envelope(), label: 'x', ttlMs: MAX_TTL_MS + 1 });
        expect(r).toEqual({ ok: false, error: 'ttl_too_long' });
    });

    it('rejects a non-positive TTL', () => {
        expect(validateProvisionPayload({ ...envelope(), label: 'x', ttlMs: 0 }).error).toBe('invalid_ttl');
    });
});

describe('spaceToken — names must not leak who booked', () => {
    it('is opaque: no label content, just base36', () => {
        const t = spaceToken();
        expect(t).toMatch(/^[0-9a-z]+$/);
        expect(t.length).toBeGreaterThanOrEqual(12);
    });

    it('does not repeat', () => {
        const seen = new Set(Array.from({ length: 200 }, () => spaceToken()));
        expect(seen.size).toBe(200);
    });
});

describe('resolveConsumedCode — which invite did this join use?', () => {
    const map = (obj) => new Map(Object.entries(obj));

    it('picks the invite that vanished (maxUses:1 is consumed on use)', () => {
        expect(resolveConsumedCode(map({ aaa: 0, bbb: 0 }), map({ bbb: 0 }))).toBe('aaa');
    });

    it('falls back to a use-count increase when the invite survives', () => {
        expect(resolveConsumedCode(map({ aaa: 0, bbb: 3 }), map({ aaa: 0, bbb: 4 }))).toBe('bbb');
    });

    // The race this design is most exposed to. Guessing would put a stranger
    // in someone else's private channel, so ambiguity must resolve to null.
    it('REFUSES to guess when two invites vanish at once', () => {
        expect(resolveConsumedCode(map({ aaa: 0, bbb: 0 }), map({}))).toBeNull();
    });

    it('refuses to guess when two counts increase at once', () => {
        expect(resolveConsumedCode(map({ aaa: 0, bbb: 0 }), map({ aaa: 1, bbb: 1 }))).toBeNull();
    });

    it('returns null when nothing changed', () => {
        expect(resolveConsumedCode(map({ aaa: 2 }), map({ aaa: 2 }))).toBeNull();
    });

    it('returns null with no prior cache rather than attributing blindly', () => {
        expect(resolveConsumedCode(null, map({ aaa: 1 }))).toBeNull();
    });
});

describe('teardownSpace', () => {
    const makeGuild = (over = {}) => ({
        id: 'g1',
        ownerId: 'owner-1',
        members: { fetch: jest.fn().mockResolvedValue(null) },
        channels: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue() }) },
        roles: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue() }) },
        ...over,
    });
    const space = (over = {}) => ({
        spaceId: 'tok1',
        categoryId: 'cat1',
        roleId: 'role1',
        memberId: null,
        ...over,
    });

    it('deletes the category and role', async () => {
        const guild = makeGuild();
        const out = await teardownSpace(guild, space());
        expect(out.deleted).toBe(true);
        expect(guild.channels.fetch).toHaveBeenCalledWith('cat1');
        expect(guild.roles.fetch).toHaveBeenCalledWith('role1');
    });

    it('kicks the bound member', async () => {
        const kick = jest.fn().mockResolvedValue();
        const guild = makeGuild({
            members: { fetch: jest.fn().mockResolvedValue({ id: 'm1', kickable: true, kick }) },
        });
        const out = await teardownSpace(guild, space({ memberId: 'm1' }));
        expect(out.kicked).toBe(true);
        expect(kick).toHaveBeenCalled();
    });

    it('never kicks the guild owner', async () => {
        const kick = jest.fn();
        const guild = makeGuild({
            members: { fetch: jest.fn().mockResolvedValue({ id: 'owner-1', kickable: true, kick }) },
        });
        const out = await teardownSpace(guild, space({ memberId: 'owner-1' }));
        expect(kick).not.toHaveBeenCalled();
        expect(out.errors).toContain('refused_to_kick_owner');
    });

    // A guest lingering in the guild is untidy; a category surviving its sweep
    // is a permanent charge against the 500-channel ceiling.
    it('still deletes the space when the kick fails', async () => {
        const guild = makeGuild({
            members: {
                fetch: jest.fn().mockResolvedValue({
                    id: 'm1',
                    kickable: true,
                    kick: jest.fn().mockRejectedValue(new Error('boom')),
                }),
            },
        });
        const out = await teardownSpace(guild, space({ memberId: 'm1' }));
        expect(out.kicked).toBe(false);
        expect(out.deleted).toBe(true);
    });

    it('treats an already-deleted channel as success, so a half-swept space unwedges', async () => {
        const err = Object.assign(new Error('Unknown Channel'), { code: 10003 });
        const guild = makeGuild({
            channels: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockRejectedValue(err) }) },
        });
        const out = await teardownSpace(guild, space());
        expect(out.deleted).toBe(true);
    });

    it('reports NOT deleted when the channel delete genuinely fails, so it is retried', async () => {
        const err = Object.assign(new Error('Missing Permissions'), { code: 50013 });
        const guild = makeGuild({
            channels: { fetch: jest.fn().mockResolvedValue({ delete: jest.fn().mockRejectedValue(err) }) },
        });
        const out = await teardownSpace(guild, space());
        expect(out.deleted).toBe(false);
        expect(out.errors.some((e) => e.startsWith('delete_failed'))).toBe(true);
    });
});
