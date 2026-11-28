'use strict';

/**
 * Post to the operator's emergency channel: the hadoku ecosystem's
 * `DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK`, handed to the bot by its PM2
 * wrapper as `ARCHIVEBOT_EMERGENCY_WEBHOOK`. The URL is the credential.
 *
 * For things the operator must see now, not in a guild's #bot-alerts: today,
 * the honeypot (lib/gate.js). Resolves to true when Discord accepted the post,
 * false otherwise (unset, refused, timed out); never rejects, and the caller
 * decides where the message goes instead.
 */

const axios = require('axios');
const { createLogger } = require('../utils/logger');

const log = createLogger('emergency');

const TIMEOUT_MS = 10_000;
// Discord's cap on a webhook message's content.
const CONTENT_LIMIT = 2000;

function webhookUrl() {
    return (process.env.ARCHIVEBOT_EMERGENCY_WEBHOOK || '').trim();
}

async function postEmergency(content, { source } = {}) {
    const url = webhookUrl();
    if (!url) {
        log.warn('emergency_webhook_unset', { source });
        return false;
    }
    try {
        await axios.post(
            url,
            {
                username: 'ArchiveBot',
                content: content.slice(0, CONTENT_LIMIT),
                // The content quotes text a stranger wrote; nothing in it may ping.
                allowed_mentions: { parse: [] },
            },
            { timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
        );
        return true;
    } catch (err) {
        const status = err.response?.status;
        log.error('emergency_post_failed', err, { source, ...(status ? { status } : {}) });
        return false;
    }
}

module.exports = { postEmergency, CONTENT_LIMIT };
