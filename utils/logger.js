/**
 * ArchiveBot's logging surface, on top of the ecosystem logger.
 *
 * This used to be a self-contained JSON logger. It emitted
 * `{"timestamp":…,"level":…,"module":…,"action":…,"status":…}` per line, which
 * was internally consistent and invisible to everything else: the hadoku
 * convention is a flat `key=val` line carrying `event=<name>` for terminal
 * failures, so `grep event=` across every service log finds every backend
 * failure — and it found nothing from this bot.
 *
 * The call-site surface is deliberately unchanged. `createLogger(module)` and
 * its six methods keep their exact signatures, so the 11 import sites and the
 * several hundred calls behind them did not all have to move in one commit.
 * That is the same adapter shape `@wolffm/worker-utils` uses to sit its worker
 * call sites on `@wolffm/logger/worker`.
 *
 * ESM from CommonJS: `@wolffm/logger` is `"type": "module"` with no `require`
 * condition, and this codebase is CommonJS. `require()` of a synchronous ESM
 * graph is supported unflagged from Node 22.12, and PM2 runs this bot on
 * /usr/local/bin/node v22.14 — verified against that binary specifically, not
 * against whatever `node` resolves to on a shell PATH.
 *
 * NOT wired: the logger's optional telemetrySink, which would mirror every
 * ERROR and WARN into monitoring-api. lib/ledger.js already reports failures
 * there under a curated `alert.archivebot.*` namespace, chosen so the alerts
 * domain carries missed notifications and not the routine 4xx a webhook
 * answers all day. Turning the sink on as well would both duplicate those and
 * drown them.
 */

const { createServerLogger } = require('@wolffm/logger/server');

const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * LOG_LEVEL has always been documented and used uppercase here; the shared
 * logger takes lowercase. Anything unrecognised falls back to info rather than
 * silencing the service, which is what an unvalidated pass-through would risk.
 */
function resolveLevel(raw) {
    const level = String(raw || '').toLowerCase();
    return LEVELS.includes(level) ? level : 'info';
}

/**
 * Action names in this codebase are a mix of camelCase (`fireItem`) and
 * snake_case (`event_create_failed`) — both were only ever a JSON field, so
 * nothing forced a choice. As `event=<name>` they are a grep target shared with
 * every other service, all of which use snake_case, so they are normalised.
 * Nothing greps the old names: until now there was no `event=` token to grep.
 */
function toEventName(action) {
    return String(action)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase();
}

const base = createServerLogger({
    service: 'archive-bot',
    minLevel: resolveLevel(process.env.LOG_LEVEL),
});

/**
 * A module-scoped logger. `module` becomes a nested service label, so lines
 * read `[archive-bot/scheduler]` rather than carrying the module as a field.
 *
 * The status values the old format carried are preserved as context rather
 * than dropped: SUCCESS and FAILED were the only way to tell an action that
 * completed from one that was refused, and both render at info.
 */
function createLogger(moduleName) {
    const log = base.child(moduleName);

    return {
        debug: (action, details = {}) => log.debug(action, details),
        info: (action, details = {}) => log.info(action, details),
        success: (action, details = {}) => log.info(action, { ...details, status: 'SUCCESS' }),

        /**
         * A REFUSED request — permission denied, unparseable input. Every
         * caller uses it that way, so it stays at info: it is the bot behaving
         * correctly, not an operational problem.
         */
        fail: (action, details = {}) => log.info(action, { ...details, status: 'FAILED' }),

        warn: (action, details = {}) => log.warn(action, details),

        /**
         * A terminal failure, so it goes out as `event=<name>` at ERROR — the
         * convention the rest of the ecosystem greps for.
         *
         * `err` is Error | string | null; several call sites pass null where
         * there is no throw to report, and a null must not become the string
         * "null" in the line.
         */
        error: (action, err, details = {}) => {
            const context = { ...details };
            if (err instanceof Error) {
                context.error = err.message;
                // Flattened to one physical line. The shared formatter renders
                // context as key=val and quotes a value containing spaces, but
                // it does not escape newlines — so a raw stack would push
                // `event=<name>` onto the last frame and split one entry across
                // twenty lines. The old JSON format escaped them to \n and so
                // was single-line too; this keeps that, readably.
                if (err.stack) context.stack = err.stack.replace(/\s*\n\s*/g, ' | ');
            } else if (err !== null && err !== undefined) {
                context.error = String(err);
            }
            log.event(toEventName(action), context);
        },
    };
}

module.exports = { createLogger, toEventName };
