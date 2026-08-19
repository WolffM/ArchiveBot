/**
 * lib/ledger.js — the monitoring-api mirror.
 *
 * This module had no tests, which is part of why the gap it now closes went
 * unnoticed: every call site was on a success path, so a bot whose reminders
 * had stopped firing entirely produced the same ledger as a quiet week. The
 * two namespaces are the contract worth pinning — `archivebot.*` is activity
 * and counts toward nothing, `alert.archivebot.*` is a notification somebody
 * was owed and did not get.
 */

jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve({ status: 200 })) }));

const KEY = 'test-service-key';

/**
 * The axios mock the ledger is currently holding. resetModules re-runs the
 * jest.mock factory, so a reference captured before the reset is a DIFFERENT
 * jest.fn than the one under test — it has to be re-read after every load.
 */
let axios;

/** Re-require the module with a fresh env — it reads config at load time. */
function loadLedger({ key = KEY, url } = {}) {
    jest.resetModules();
    if (key === null) delete process.env.MONITORING_SERVICE_KEY;
    else process.env.MONITORING_SERVICE_KEY = key;
    if (url === undefined) delete process.env.MONITORING_TELEMETRY_URL;
    else process.env.MONITORING_TELEMETRY_URL = url;
    axios = require('axios');
    axios.post.mockImplementation(() => Promise.resolve({ status: 200 }));
    return require('../lib/ledger');
}

/** The body of the single POST made, or null if none was made. */
function postedBody() {
    if (axios.post.mock.calls.length === 0) return null;
    return axios.post.mock.calls[0][1];
}

describe('ledger', () => {
    const originalKey = process.env.MONITORING_SERVICE_KEY;
    const originalUrl = process.env.MONITORING_TELEMETRY_URL;

    afterAll(() => {
        if (originalKey === undefined) delete process.env.MONITORING_SERVICE_KEY;
        else process.env.MONITORING_SERVICE_KEY = originalKey;
        if (originalUrl === undefined) delete process.env.MONITORING_TELEMETRY_URL;
        else process.env.MONITORING_TELEMETRY_URL = originalUrl;
    });

    describe('without a service key', () => {
        it('mirrors nothing at all — the mirror is opt-in', () => {
            const { mirrorToLedger, mirrorFailureToLedger } = loadLedger({ key: null });

            mirrorToLedger('archivebot.reminder', 'fired');
            mirrorFailureToLedger('archivebot.reminder', 'not fired');

            expect(axios.post).not.toHaveBeenCalled();
        });
    });

    describe('activity', () => {
        it('posts at info level under the plain namespace', () => {
            const { mirrorToLedger } = loadLedger();

            mirrorToLedger('archivebot.reminder', 'event_reminder reminder fired', {
                itemType: 'event_reminder',
                guildId: 'g-1',
            });

            expect(axios.post).toHaveBeenCalledTimes(1);
            const body = postedBody();
            expect(body.level).toBe('info');
            expect(body.source).toBe('service');
            expect(body.message).toBe('event=archivebot.reminder event_reminder reminder fired');
            expect(body.context).toMatchObject({
                service: 'archive-bot',
                channel: 'discord',
                itemType: 'event_reminder',
                guildId: 'g-1',
            });
        });

        it('sends the service key as X-User-Key', () => {
            const { mirrorToLedger } = loadLedger();
            mirrorToLedger('archivebot.message', 'message posted');

            expect(axios.post.mock.calls[0][2].headers['X-User-Key']).toBe(KEY);
        });

        it('honours a configured telemetry URL, defaulting to the hadoku one', () => {
            const { mirrorToLedger } = loadLedger({ url: 'https://example.test/ingest' });
            mirrorToLedger('archivebot.message', 'message posted');
            expect(axios.post.mock.calls[0][0]).toBe('https://example.test/ingest');

            const fresh = loadLedger();
            fresh.mirrorToLedger('archivebot.message', 'message posted');
            expect(axios.post.mock.calls[0][0]).toBe('https://hadoku.me/health/api/telemetry');
        });
    });

    describe('failures', () => {
        it('posts at error level under the alert namespace', () => {
            const { mirrorFailureToLedger } = loadLedger();

            mirrorFailureToLedger('archivebot.reminder', 'reminder failed to fire', {
                itemType: 'event_reminder',
                guildId: 'g-1',
            });

            const body = postedBody();
            expect(body.level).toBe('error');
            // The alert. prefix is what puts it in the sitrep alerts domain
            // rather than the events feed, matching alert.mgmt.<source>.
            expect(body.message).toBe('event=alert.archivebot.reminder reminder failed to fire');
            expect(body.context).toMatchObject({ service: 'archive-bot', guildId: 'g-1' });
        });

        it('flattens an Error to its message so the row stays queryable', () => {
            const { mirrorFailureToLedger } = loadLedger();

            mirrorFailureToLedger('archivebot.message', 'message not delivered', {
                channelId: 'c-1',
                error: new Error('Missing Permissions'),
            });

            expect(postedBody().context.error).toBe('Missing Permissions');
        });

        it('stringifies a non-Error error rather than nesting an object', () => {
            const { mirrorFailureToLedger } = loadLedger();

            mirrorFailureToLedger('archivebot.event', 'event not created', { error: 50013 });

            expect(postedBody().context.error).toBe('50013');
        });

        it('omits the error key entirely when there is no error to report', () => {
            const { mirrorFailureToLedger } = loadLedger();

            mirrorFailureToLedger('archivebot.reminder', 'reminder retired undelivered', {
                reason: 'Channel no longer exists',
            });

            const { context } = postedBody();
            expect(context).toMatchObject({ reason: 'Channel no longer exists' });
            expect('error' in context).toBe(false);
        });
    });

    describe('resilience', () => {
        it('caps the message so one long title cannot blow the row', () => {
            const { mirrorToLedger } = loadLedger();
            mirrorToLedger('archivebot.event', 'x'.repeat(5000));

            expect(postedBody().message).toHaveLength(1000);
        });

        it('swallows a rejected POST — the notification already went out', async () => {
            const { mirrorFailureToLedger } = loadLedger();
            axios.post.mockImplementation(() => Promise.reject(new Error('monitoring down')));

            expect(() =>
                mirrorFailureToLedger('archivebot.reminder', 'reminder failed to fire')
            ).not.toThrow();

            // Let the rejection settle: an unhandled one would fail the run.
            await new Promise((resolve) => setImmediate(resolve));
        });

        it('does not await the POST — telemetry never delays a notification', () => {
            const { mirrorToLedger } = loadLedger();
            let settled = false;
            axios.post.mockImplementation(
                () => new Promise((resolve) => setTimeout(() => { settled = true; resolve({}); }, 50))
            );

            mirrorToLedger('archivebot.reminder', 'fired');

            expect(settled).toBe(false);
        });
    });
});
