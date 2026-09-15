/**
 * The intro post and the pre-meeting reminder.
 *
 * Two things here are worth a test rather than a reading: the UNIT of a Discord
 * timestamp tag, and the promise that a reminder fires exactly once and never
 * late. Both fail silently in production — a millisecond timestamp renders as a
 * date fifty thousand years out with no error, and a reminder that fires twice
 * or an hour late still looks like a working feature in the logs.
 */
const announce = require('../lib/meetingSpaceAnnounce');
const store = require('../lib/meetingSpaceStore');

const GUILD_ID = 'guild-announce-test';

function channelStub() {
    return { id: 'chat-1', send: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
}

function guildWith(channel) {
    return {
        id: GUILD_ID,
        channels: {
            fetch: jest.fn().mockImplementation(async id => {
                if (channel && id === channel.id) return channel;
                throw new Error('Unknown Channel');
            }),
        },
    };
}

const client = guild => ({ guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: jest.fn() } });

function spaceRecord(overrides = {}) {
    const startsAt = overrides.startsAt ?? new Date(Date.now() + 10 * 60 * 1000).toISOString();
    return {
        spaceId: 'sp1',
        idempotencyKey: 'k-sp1',
        guildId: GUILD_ID,
        label: 'operator only',
        title: 'Intro call',
        categoryId: 'cat-1',
        roleId: 'role-1',
        channelIds: ['chat-1', 'voice-1'],
        chatChannelId: 'chat-1',
        startsAt,
        remindAt: startsAt ? new Date(Date.parse(startsAt) - announce.REMINDER_LEAD_MS).toISOString() : null,
        remindedAt: null,
        active: true,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        ...overrides,
    };
}

describe('timestamp tags — the unit that renders as the year 51,000', () => {
    it('emits SECONDS, not the milliseconds every Date here carries', () => {
        // 1789505340 is the value in the reported format; its Date is in ms.
        const iso = new Date(1789505340000).toISOString();
        expect(announce.timestampTag(iso, 'R')).toBe('<t:1789505340:R>');
    });

    it('never emits a 13-digit value, whatever the style', () => {
        const iso = new Date().toISOString();
        for (const style of ['F', 'R', 't']) {
            const tag = announce.timestampTag(iso, style);
            const digits = tag.match(/^<t:(\d+):/)[1];
            expect(digits.length).toBeLessThanOrEqual(11);
        }
    });

    it('returns null for an unparseable time rather than <t:NaN:R>', () => {
        expect(announce.timestampTag('not a date', 'R')).toBeNull();
        expect(announce.unixSeconds('not a date')).toBeNull();
    });
});

describe('intro message', () => {
    it('carries both an absolute and a relative tag', () => {
        const text = announce.introText(spaceRecord({ startsAt: new Date(1789505340000).toISOString() }));
        expect(text).toContain('<t:1789505340:F>');
        expect(text).toContain('<t:1789505340:R>');
        expect(text).toContain('Intro call');
    });

    // A space with no start is a valid generic space, not an error.
    it('omits the time entirely when the caller gave none', () => {
        const text = announce.introText(spaceRecord({ startsAt: null, remindAt: null }));
        expect(text).not.toContain('<t:');
        expect(text).not.toMatch(/five minutes/);
        expect(text).toContain('Meeting Room');
    });

    // The intro is not the ping. Pinging on provision would fire days early.
    it('does not mention anyone', async () => {
        const channel = channelStub();
        await announce.postIntro(guildWith(channel), spaceRecord());

        const sent = channel.send.mock.calls[0][0];
        expect(sent.allowedMentions).toEqual({ parse: [] });
        expect(sent.content).not.toContain('@everyone');
    });

    it('reports failure instead of throwing, so a greeting cannot undo a space', async () => {
        const channel = channelStub();
        channel.send.mockRejectedValue(new Error('Missing Permissions'));
        await expect(announce.postIntro(guildWith(channel), spaceRecord())).resolves.toBe(false);
    });

    it('writes to the NAMED chat channel, not channelIds[0]', async () => {
        const channel = { id: 'text-chan', send: jest.fn().mockResolvedValue({}) };
        const guild = guildWith(channel);
        // channelIds deliberately lists the voice channel first.
        await announce.postIntro(
            guild,
            spaceRecord({ chatChannelId: 'text-chan', channelIds: ['voice-1', 'text-chan'] })
        );
        expect(channel.send).toHaveBeenCalled();
    });
});

describe('reminder sweep', () => {
    beforeEach(() => {
        store.save(GUILD_ID, { spaces: [] });
    });

    it('does not fire before it is due', async () => {
        const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const channel = channelStub();
        const summary = await announce.sweepDueReminders(client(guildWith(channel)));

        expect(channel.send).not.toHaveBeenCalled();
        expect(summary.sent).toBe(0);
    });

    it('fires five minutes out, pinging everyone in the private space', async () => {
        const startsAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const channel = channelStub();
        const summary = await announce.sweepDueReminders(client(guildWith(channel)));

        expect(summary.sent).toBe(1);
        const sent = channel.send.mock.calls[0][0];
        expect(sent.content).toContain('@everyone');
        // Without this the mention renders as plain text and nobody is notified.
        expect(sent.allowedMentions).toEqual({ parse: ['everyone'] });
        expect(sent.content).toMatch(/<t:\d{1,11}:R>/);
    });

    // The whole point of stamping the record.
    it('fires exactly once across repeated ticks', async () => {
        const startsAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const channel = channelStub();
        const c = client(guildWith(channel));
        await announce.sweepDueReminders(c);
        await announce.sweepDueReminders(c);
        await announce.sweepDueReminders(c);

        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    // The bot was down over the meeting. "Starting in 5 minutes" about something
    // that finished an hour ago is worse than silence, because it is believed.
    it('retires a reminder it missed instead of sending it late', async () => {
        const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const channel = channelStub();
        const summary = await announce.sweepDueReminders(client(guildWith(channel)));

        expect(channel.send).not.toHaveBeenCalled();
        expect(summary.expired).toBe(1);
        expect(store.findBySpaceId(GUILD_ID, 'sp1').reminderSkipped).toBe('too_late');
    });

    // A send that failed inside the window is worth another 60 seconds.
    it('leaves a transient failure unstamped so the next tick retries', async () => {
        const startsAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const channel = channelStub();
        channel.send.mockRejectedValueOnce(new Error('503'));
        const c = client(guildWith(channel));

        const first = await announce.sweepDueReminders(c);
        expect(first.failed).toBe(1);
        expect(store.findBySpaceId(GUILD_ID, 'sp1').remindedAt).toBeFalsy();

        const second = await announce.sweepDueReminders(c);
        expect(second.sent).toBe(1);
    });

    // Cleanup is structural: an inactive space has no pending reminder, with no
    // separate queue to prune on teardown.
    it('ignores a space that has been torn down', async () => {
        const startsAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt, active: false })] });

        const channel = channelStub();
        const summary = await announce.sweepDueReminders(client(guildWith(channel)));

        expect(channel.send).not.toHaveBeenCalled();
        expect(summary.sent).toBe(0);
    });

    it('retires rather than retries when the channel is gone', async () => {
        const startsAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt })] });

        const summary = await announce.sweepDueReminders(client(guildWith(null)));

        expect(summary.expired).toBe(1);
        expect(store.findBySpaceId(GUILD_ID, 'sp1').reminderSkipped).toBe('no_channel');
    });

    it('has nothing to do for a space with no start time', async () => {
        store.save(GUILD_ID, { spaces: [spaceRecord({ startsAt: null, remindAt: null })] });

        const channel = channelStub();
        const summary = await announce.sweepDueReminders(client(guildWith(channel)));

        expect(channel.send).not.toHaveBeenCalled();
        expect(summary).toEqual({ sent: 0, expired: 0, failed: 0 });
    });
});
