'use strict';

/**
 * Mirror a Discord notification into monitoring-api's event ledger
 * (service_events) so ArchiveBot's notifications are visible in the unified
 * hadoku sitrep alongside every other service, not only in the Discord channel.
 *
 * Best-effort and fire-and-forget: no-op unless MONITORING_SERVICE_KEY is set
 * (a monitoring service-tier key — provision it to turn the mirror on). A
 * failed POST is swallowed; a notification must never depend on the ledger.
 *
 * Reminders and waitlist outcomes are activity, not operational problems, so
 * they are tagged `archivebot.*` (visible in the events feed) rather than
 * `alert.*` (which would count them in the sitrep alerts domain).
 */

const axios = require('axios');

const TELEMETRY_URL =
    process.env.MONITORING_TELEMETRY_URL || 'https://hadoku.me/health/api/telemetry';
const SERVICE_KEY = process.env.MONITORING_SERVICE_KEY || '';

function mirrorToLedger(name, message, context = {}) {
    if (!SERVICE_KEY) return;
    const body = {
        source: 'service',
        level: 'info',
        type: 'log',
        message: `event=${name} ${message}`.slice(0, 1000),
        context: { service: 'archive-bot', channel: 'discord', ...context },
    };
    axios
        .post(TELEMETRY_URL, body, {
            headers: { 'X-User-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
            timeout: 5000,
        })
        .catch(() => {
            // Fire-and-forget — the notification already reached Discord.
        });
}

module.exports = { mirrorToLedger };
