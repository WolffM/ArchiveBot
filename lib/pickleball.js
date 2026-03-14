const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createLogger } = require('../utils/logger');

const log = createLogger('pickleball');

const SCRAPE_BASE = process.env.SCRAPE_API_URL || 'https://hadoku.me/scraper';
const SCRAPE_KEY = process.env.SCRAPE_API_KEY;
const SCRAPE_SERVICE_KEY = process.env.SCRAPE_SERVICE_KEY;

const api = axios.create({
    baseURL: SCRAPE_BASE,
    headers: {
        'Authorization': `Bearer ${SCRAPE_KEY}`,
        'X-User-Key': SCRAPE_SERVICE_KEY,
        'Content-Type': 'application/json'
    },
    timeout: 15000
});

const SIGNUP_PARAMS = {
    event_day: 'Tue',
    event_time: '7pm-9pm',
    event_name: 'Open Play - Social / Low Intermediate',
    location: 'Lynnwood',
    time_flex_hours: 2
};

const FIND_PARAMS = {
    event_day: 'Wed',
    event_time: '7pm-9pm',
    event_name: 'Open Play - Intermediate',
    location: 'Lynnwood',
    time_flex_hours: 2
};

// ============ Actions ============

async function executeAction(action, channel) {
    if (!SCRAPE_KEY || !SCRAPE_SERVICE_KEY) {
        log.warn('executeAction', { reason: 'SCRAPE_API_KEY or SCRAPE_SERVICE_KEY not configured, skipping action', action });
        return;
    }

    switch (action) {
        case 'pickleball_signup':
            return runSignupAction(channel);
        case 'pickleball_find':
            return runFindAction(channel);
        default:
            log.warn('executeAction', { reason: 'Unknown action', action });
    }
}

// ============ Sunday: Auto-Signup ============

async function runSignupAction(channel) {
    let msg;
    try {
        const { data: resp } = await api.post('/api/v1/pickleball/signup', SIGNUP_PARAMS);

        if (!resp.success) {
            const errMsg = resp.error?.message || 'Unknown error';
            log.error('runSignupAction', { reason: 'API returned failure', error: errMsg });
            await channel.send(`Failed to start pickleball signup: ${errMsg}`);
            return;
        }

        msg = await channel.send('Pickleball signup started...');
        const result = await pollStatus(90000, 3000);

        if (result.status === 'completed') {
            await msg.edit(
                `**Signup Complete!**\n` +
                `Event: ${result.event_title}\n` +
                `Time: ${result.matched_time || SIGNUP_PARAMS.event_time}\n` +
                (result.spots_left != null ? `Spots Left: ${result.spots_left}\n` : '') +
                (result.event_url ? `${result.event_url}` : '')
            );
        } else {
            await msg.edit(`**Signup Failed**\nError: ${result.error || 'Unknown error'}`);
        }
    } catch (error) {
        const detail = error.response?.data?.error || error.response?.data?.message || error.message;
        log.error('runSignupAction', error, { status: error.response?.status, detail });
        const errText = `Pickleball signup error: ${detail}`;
        if (msg) {
            await msg.edit(errText).catch(() => {});
        } else {
            await channel.send(errText).catch(() => {});
        }
    }
}

// ============ Monday: Find + Button ============

async function runFindAction(channel) {
    let msg;
    try {
        const { data: resp } = await api.post('/api/v1/pickleball/find', FIND_PARAMS);

        if (!resp.success) {
            const errMsg = resp.error?.message || 'Could not find event';
            log.error('runFindAction', { reason: 'API returned failure', error: errMsg });
            await channel.send(`Pickleball event not found: ${errMsg}`);
            return;
        }

        msg = await channel.send('Searching for pickleball event...');
        const result = await pollStatus(90000, 3000);

        if (result.status === 'completed') {
            let text = `**Pickleball Event Found!**\n` +
                `**Event:** ${result.event_title}\n` +
                `**Time:** ${result.matched_time || FIND_PARAMS.event_time}\n` +
                `**Location:** ${FIND_PARAMS.location}\n`;

            if (result.spots_left != null) {
                text += `**Spots Left:** ${result.spots_left}\n`;
            }

            if (result.signup_opens_at) {
                text += `\nSignup opens at: ${new Date(result.signup_opens_at).toLocaleString()}\n`;
            }

            const messageOptions = { content: text };

            if (result.signup_url) {
                const button = new ButtonBuilder()
                    .setLabel('Sign Up')
                    .setStyle(ButtonStyle.Link)
                    .setURL(result.signup_url);
                messageOptions.components = [new ActionRowBuilder().addComponents(button)];
            }

            await msg.edit(messageOptions);
        } else {
            await msg.edit(`**Pickleball Find Failed**\nError: ${result.error || 'Unknown error'}`);
        }
    } catch (error) {
        const detail = error.response?.data?.error || error.response?.data?.message || error.message;
        log.error('runFindAction', error, { status: error.response?.status, detail });
        const errText = `Pickleball find error: ${detail}`;
        if (msg) {
            await msg.edit(errText).catch(() => {});
        } else {
            await channel.send(errText).catch(() => {});
        }
    }
}

// ============ Helpers ============

async function pollStatus(maxWaitMs, intervalMs) {
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        try {
            const { data: resp } = await api.get('/api/v1/pickleball/status');
            const status = resp.data;

            if (status.status === 'completed' || status.status === 'failed') {
                return status;
            }
        } catch (error) {
            log.warn('pollStatus', { error: error.message });
        }

        await new Promise(r => setTimeout(r, intervalMs));
    }

    return { status: 'timeout', error: 'Signup timed out after ' + Math.round(maxWaitMs / 1000) + 's' };
}

module.exports = { executeAction, runSignupAction, runFindAction, pollStatus };
