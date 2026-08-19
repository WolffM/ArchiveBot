'use strict';

/**
 * Mirror ArchiveBot's notifications into monitoring-api's event ledger
 * (service_events) so they are visible in the unified hadoku sitrep alongside
 * every other service, not only in the Discord channel.
 *
 * Best-effort and fire-and-forget: no-op unless MONITORING_SERVICE_KEY is set
 * (a monitoring service-tier key — provision it to turn the mirror on). A
 * failed POST is swallowed; a notification must never depend on the ledger.
 *
 * Two namespaces, and the split is the point:
 *
 *   archivebot.*        activity. A reminder fired, an event was created. This
 *                       is what the bot doing its job looks like, so it lands
 *                       in the events feed and counts toward nothing.
 *
 *   alert.archivebot.*  a notification somebody was owed did not happen. That
 *                       belongs in the sitrep alerts domain, the same shape
 *                       mgmt-api's discord-sink uses for `alert.mgmt.<source>`.
 *
 * Only the second existed as a comment; nothing ever emitted one. Every mirror
 * call was on a success path, which meant a bot whose reminders had stopped
 * firing entirely looked identical to a quiet week — the sitrep would show no
 * activity and no alerts, and no-one would know which. Failures now report
 * themselves.
 */

const axios = require('axios');

const TELEMETRY_URL =
    process.env.MONITORING_TELEMETRY_URL || 'https://hadoku.me/health/api/telemetry';
const SERVICE_KEY = process.env.MONITORING_SERVICE_KEY || '';

function post(level, name, message, context) {
    if (!SERVICE_KEY) return;
    const body = {
        source: 'service',
        level,
        type: 'log',
        // `event=<name> ` prefix is the ecosystem's greppable convention — one
        // `grep event=alert.archivebot` finds every missed notification.
        message: `event=${name} ${message}`.slice(0, 1000),
        context: { service: 'archive-bot', channel: 'discord', ...context },
    };
    axios
        .post(TELEMETRY_URL, body, {
            headers: { 'X-User-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
            timeout: 5000,
        })
        .catch(() => {
            // Fire-and-forget — the notification already reached Discord, and a
            // telemetry outage must not turn into a second failure here.
        });
}

/** Activity: the bot did the thing it exists to do. */
function mirrorToLedger(name, message, context = {}) {
    post('info', name, message, context);
}

/**
 * A notification someone was owed did not go out.
 *
 * Reserved for exactly that — not for a rejected request. A webhook refused
 * for a bad signature or an unparseable payload is the caller's bug and is
 * already answered with a 4xx; alerting on it would drown the real thing.
 *
 * `error` is normalised to a string here so the ledger row is queryable rather
 * than carrying a serialised Error whose shape varies by throw site.
 */
function mirrorFailureToLedger(name, message, context = {}) {
    const { error, ...rest } = context;
    post('error', `alert.${name}`, message, {
        ...rest,
        ...(error === undefined
            ? {}
            : { error: error instanceof Error ? error.message : String(error) }),
    });
}

module.exports = { mirrorToLedger, mirrorFailureToLedger };
