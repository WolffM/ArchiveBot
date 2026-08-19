/**
 * utils/logger.js — the adapter that sits this bot's call sites on
 * @wolffm/logger/server.
 *
 * These assert against the REAL package, not a stub: the whole point of the
 * migration is that lines come out in the ecosystem's shape, and a stub would
 * only prove the adapter agrees with itself. What matters is the rendered
 * line, so that is what is captured.
 *
 * The contract worth pinning is the mapping. Six legacy methods, four levels,
 * and one rule that carries the value: an error becomes `event=<name>` at
 * ERROR, which is what makes `grep event=` find this bot's failures alongside
 * every other service's.
 */

/** Lines written to stdout/stderr while `fn` runs. */
function capture(fn) {
    const out = [];
    const err = [];
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
    });
    try {
        fn();
    } finally {
        stdout.mockRestore();
        stderr.mockRestore();
    }
    return { out: out.join(''), err: err.join('') };
}

/** Re-require with a fresh LOG_LEVEL — it is read once, at module load. */
function loadLogger(level) {
    jest.resetModules();
    if (level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = level;
    return require('../utils/logger');
}

describe('logger', () => {
    const originalLevel = process.env.LOG_LEVEL;

    afterAll(() => {
        if (originalLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = originalLevel;
    });

    describe('toEventName', () => {
        const { toEventName } = require('../utils/logger');

        it.each([
            ['fireItem', 'fire_item'],
            ['handleScheduledEventUpdate', 'handle_scheduled_event_update'],
            ['buildEventReminderMessage', 'build_event_reminder_message'],
            // Already snake_case, and must survive untouched.
            ['event_create_failed', 'event_create_failed'],
            ['missing_send_permission', 'missing_send_permission'],
            // Digits are a word boundary the naive regex gets wrong.
            ['archiveS3Bucket', 'archive_s3_bucket'],
        ])('normalises %s to %s', (input, expected) => {
            expect(toEventName(input)).toBe(expected);
        });
    });

    describe('levels', () => {
        it('routes info, success and fail to stdout at INFO', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out, err } = capture(() => {
                log.info('reconcileEvent', { itemId: 1 });
                log.success('fireItem', { itemId: 2 });
                log.fail('handleAddCommand', { reason: 'Permission denied' });
            });

            expect(err).toBe('');
            expect(out.trim().split('\n')).toHaveLength(3);
            expect(out).toContain('[INFO] [archive-bot/scheduler]');
        });

        it('routes warn to stdout at WARN', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out, err } = capture(() => log.warn('deactivateItem', { itemId: 1 }));

            expect(err).toBe('');
            expect(out).toContain('[WARN] [archive-bot/scheduler]');
        });

        it('routes error to stderr at ERROR', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out, err } = capture(() => log.error('fireItem', new Error('boom')));

            expect(out).toBe('');
            expect(err).toContain('[ERROR] [archive-bot/scheduler]');
        });
    });

    describe('the status the old format carried', () => {
        it('marks a success and a refusal apart, since both are INFO', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out } = capture(() => {
                log.success('fireItem', { itemId: 2 });
                log.fail('handleAddCommand', { reason: 'Permission denied' });
            });

            const [success, refused] = out.trim().split('\n');
            expect(success).toContain('status=SUCCESS');
            expect(refused).toContain('status=FAILED');
        });

        it('leaves a plain info line unmarked', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out } = capture(() => log.info('reconcileEvent', { itemId: 1 }));
            expect(out).not.toContain('status=');
        });
    });

    describe('errors', () => {
        it('emits the greppable event= token, snake_cased', () => {
            const log = loadLogger().createLogger('scheduler');
            const { err } = capture(() => log.error('fireItem', new Error('boom'), { itemId: 9 }));

            expect(err).toContain('event=fire_item');
            expect(err).toContain('itemId=9');
            expect(err).toContain('error=boom');
        });

        it('keeps the whole entry on one physical line despite the stack', () => {
            const log = loadLogger().createLogger('scheduler');
            const { err } = capture(() => log.error('fireItem', new Error('boom')));

            // A raw multi-line stack would push event= onto the last frame and
            // split one entry across twenty lines.
            expect(err.trimEnd().split('\n')).toHaveLength(1);
            expect(err).toContain('stack=');
            expect(err).toContain(' | ');
        });

        it('omits the error key when the call site has no throw to report', () => {
            const log = loadLogger().createLogger('webhook');
            const { err } = capture(() => log.error('channel_not_sendable', null, { channelId: 'c1' }));

            expect(err).toContain('event=channel_not_sendable');
            expect(err).toContain('channelId=c1');
            expect(err).not.toContain('error=');
            expect(err).not.toContain('null');
        });

        it('accepts a bare string where a call site never had an Error', () => {
            const log = loadLogger().createLogger('pickleball');
            const { err } = capture(() => log.error('runSignupAction', 'API returned failure'));

            expect(err).toContain('error="API returned failure"');
        });
    });

    describe('LOG_LEVEL', () => {
        it('accepts the uppercase spelling this bot has always used', () => {
            const log = loadLogger('WARN').createLogger('scheduler');
            const { out } = capture(() => {
                log.info('quiet', {});
                log.warn('loud', {});
            });

            expect(out).not.toContain('quiet');
            expect(out).toContain('loud');
        });

        it('falls back to info on an unrecognised value rather than going silent', () => {
            const log = loadLogger('verbose').createLogger('scheduler');
            const { out } = capture(() => log.info('still here', {}));
            expect(out).toContain('still here');
        });

        it('defaults to info when unset', () => {
            const log = loadLogger().createLogger('scheduler');
            const { out } = capture(() => log.info('still here', {}));
            expect(out).toContain('still here');
        });
    });

    describe('module labelling', () => {
        it('nests the module under the service, so lines say which part spoke', () => {
            const { createLogger } = loadLogger();
            const { out } = capture(() => {
                createLogger('scheduler').info('a', {});
                createLogger('archive').info('b', {});
            });

            expect(out).toContain('[archive-bot/scheduler]');
            expect(out).toContain('[archive-bot/archive]');
        });
    });
});
