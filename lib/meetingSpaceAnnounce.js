/**
 * What a meeting space SAYS: the intro post, and the reminder before the hour.
 *
 * ## Why this exists at all
 *
 * A space is a category, two channels and a role. None of that carries a TIME.
 * Discord's own scheduled events would, but they are not used here — an event
 * is a guild-wide object and these meetings are one-guest-each by construction,
 * so the thing that would show the time is the one thing that cannot be kept
 * private. The guest therefore arrives in a room with no indication of when the
 * meeting is, holding an email in a timezone that may not be theirs.
 *
 * Two messages close that, both inside the guest's own `chat` channel:
 *
 *   1. An intro, posted at provision time so it is waiting when they arrive.
 *   2. An `@everyone` five minutes before the start.
 *
 * ## Discord timestamps, and the unit that bites
 *
 * `<t:SECONDS:R>` renders in the READER's timezone and counts down on its own —
 * which is the entire point, because the server knows the operator's timezone
 * and nothing about the guest's. The argument is UNIX SECONDS, not the
 * milliseconds every Date in this codebase deals in: pass milliseconds and
 * Discord renders a date about fifty thousand years out, with no error. That is
 * what `unixSeconds` is for, and why nothing here formats a time by hand.
 *
 * `:F` gives the absolute ("Tuesday, 16 September 2026 14:45"), `:R` the
 * relative ("in 2 days"). Both, because a countdown alone is useless for
 * writing down and a date alone is what the email already said.
 *
 * ## Why `@everyone` is safe here
 *
 * It would not be in a normal channel. It is safe in a space because the
 * category denies `@everyone` the ViewChannel permission, and a mention only
 * reaches members who can see the channel — so the audience is the one guest
 * holding the space role, plus the owner. The ping is scoped by the isolation
 * that was already there; it is not a guild-wide announcement.
 *
 * `allowedMentions` is set explicitly all the same. The client's default is
 * whatever `clientOptions` says, and a message that silently stops pinging is
 * indistinguishable from one that was never sent.
 *
 * ## Cleanup is structural, not a second job
 *
 * Neither message needs reaping. The intro lives in a channel teardown deletes,
 * and the reminder's schedule lives on the space RECORD — `remindAt` beside
 * `expiresAt` — rather than in the scheduler's `scheduled.json`. So a space that
 * is revoked, swept, or cancelled takes its pending reminder with it in the same
 * write that marks it inactive, and there is no queue that can outlive the thing
 * it refers to. That is the whole reason this does not reuse the scheduler's
 * item store, which would have needed its own removal path on every teardown.
 */

const { createLogger } = require('../utils/logger');
const store = require('./meetingSpaceStore');

const log = createLogger('meetingSpaceAnnounce');

/** How long before the start the reminder fires. */
const REMINDER_LEAD_MS = 5 * 60 * 1000;

/**
 * How late a reminder may still be sent.
 *
 * The bot can be down across a meeting — a restart, a deploy, a host reboot.
 * When it comes back the reminder is due and unsent, and firing it says "starts
 * in 5 minutes" about something that finished an hour ago. Past this window the
 * reminder is retired unsent instead, which is the honest outcome: a late
 * reminder is worse than none, because it is believed.
 */
const REMINDER_GRACE_MS = 5 * 60 * 1000;

/** Discord timestamp tags take UNIX SECONDS. Milliseconds render as nonsense. */
function unixSeconds(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `<t:1789505340:R>` — rendered by each reader's own client, in their zone. */
function timestampTag(iso, style) {
    const seconds = unixSeconds(iso);
    return seconds === null ? null : `<t:${seconds}:${style}>`;
}

/** The space's text channel, or null if it is gone. Never throws. */
async function fetchChatChannel(guild, space) {
    const id = space.chatChannelId || space.channelIds?.[0];
    if (!id) return null;
    try {
        return await guild.channels.fetch(id);
    } catch {
        return null;
    }
}

function introText(space) {
    const title = space.title || 'your meeting';
    const absolute = space.startsAt ? timestampTag(space.startsAt, 'F') : null;
    const relative = space.startsAt ? timestampTag(space.startsAt, 'R') : null;

    const lines = [`Welcome — this space is yours alone for **${title}**.`];

    if (absolute && relative) {
        lines.push('', `**When:** ${absolute} (${relative})`);
    }

    lines.push(
        '',
        'Use **chat** here for anything before we start, and join **Meeting Room** when it is time.',
        'Only you and the host can see any of this.'
    );

    if (space.startsAt) {
        lines.push('', 'I will give you a nudge five minutes before we begin.');
    }

    return lines.join('\n');
}

function reminderText(space) {
    const relative = space.startsAt ? timestampTag(space.startsAt, 'R') : null;
    const when = relative ? ` — starting ${relative}` : '';
    return `@everyone Heads up${when}. Hop into **Meeting Room** when you are ready.`;
}

/**
 * Post the intro into a freshly provisioned space.
 *
 * Best-effort by design: the space, the invite and the booking are all already
 * real by the time this runs, and failing the provision over a greeting would
 * throw away a working meeting room. The failure is logged and the caller is
 * told, so a silent regression is still visible.
 */
async function postIntro(guild, space) {
    const channel = await fetchChatChannel(guild, space);
    if (!channel || typeof channel.send !== 'function') {
        log.warn('intro_channel_missing', { spaceId: space.spaceId });
        return false;
    }

    try {
        await channel.send({
            content: introText(space),
            allowedMentions: { parse: [] },
        });
        log.info('space_intro_posted', { spaceId: space.spaceId, startsAt: space.startsAt ?? null });
        return true;
    } catch (err) {
        log.error('space_intro_failed', err, { spaceId: space.spaceId });
        return false;
    }
}

/**
 * Fire every reminder that has come due, once each.
 *
 * Driven by the scheduler's existing 60-second tick rather than a timer of its
 * own — a second interval is a second thing that can die quietly, and the one
 * that already exists is checked on every boot. Sixty seconds of jitter on a
 * five-minute warning is not worth a new clock.
 *
 * Every outcome marks the record. A reminder that was sent, one whose channel
 * has vanished, and one that came due while the bot was down are all terminal:
 * nothing is left in a state the next tick will retry forever.
 */
async function sweepDueReminders(discordClient, now = Date.now()) {
    const summary = { sent: 0, expired: 0, failed: 0 };

    for (const guildId of store.listGuildIds()) {
        const due = store.findDueReminders(guildId, now);
        if (due.length === 0) continue;

        let guild;
        try {
            guild = discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
        } catch (err) {
            log.error('reminder_guild_unreachable', err, { guildId });
            summary.failed += due.length;
            continue;
        }

        for (const space of due) {
            const startMs = Date.parse(space.startsAt);
            if (Number.isFinite(startMs) && now > startMs + REMINDER_GRACE_MS) {
                store.markReminded(guildId, space.spaceId, { reminderSkipped: 'too_late' });
                summary.expired++;
                log.info('reminder_retired_unsent', { spaceId: space.spaceId, startsAt: space.startsAt });
                continue;
            }

            const channel = await fetchChatChannel(guild, space);
            if (!channel || typeof channel.send !== 'function') {
                // The channel is gone but the record is still active — an
                // operator deleted it by hand. Retiring the reminder rather than
                // retrying is right: there is nowhere to send it, and the sweep
                // is what reconciles the record.
                store.markReminded(guildId, space.spaceId, { reminderSkipped: 'no_channel' });
                summary.expired++;
                continue;
            }

            try {
                await channel.send({
                    content: reminderText(space),
                    allowedMentions: { parse: ['everyone'] },
                });
                store.markReminded(guildId, space.spaceId);
                summary.sent++;
                log.info('space_reminder_sent', { spaceId: space.spaceId, startsAt: space.startsAt });
            } catch (err) {
                // Left unmarked so the next tick retries — inside the grace
                // window there is still time for it to matter.
                log.error('space_reminder_failed', err, { spaceId: space.spaceId });
                summary.failed++;
            }
        }
    }

    return summary;
}

module.exports = {
    postIntro,
    sweepDueReminders,
    introText,
    reminderText,
    timestampTag,
    unixSeconds,
    REMINDER_LEAD_MS,
    REMINDER_GRACE_MS,
};
