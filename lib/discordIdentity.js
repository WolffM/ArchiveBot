/**
 * Discord identity for hadoku accounts: link a Discord account, and read its
 * current avatar. The one caller is hadoku_site's prefs-api (avatars,
 * hadoku_site docs/planning/avatars-2026-10-30.md), signing with
 * ARCHIVEBOT_PREFS_WEBHOOK_SECRET.
 *
 * Every Discord credential in the hadoku ecosystem stays in this bot: the
 * application id (CLIENT_ID), the bot token, and the application's OAuth2
 * client secret (DISCORD_CLIENT_SECRET). prefs-api holds none of them.
 *
 *   /api/discord/oauth/authorize-url  { state }        → { url }
 *       The consent URL: authorization-code flow, scope `identify` only, no
 *       bot scope, redirecting to the one hadoku page that completes links.
 *   /api/discord/oauth/exchange       { code }         → { id, avatar_url }
 *       Trades the code for a token, reads /users/@me, revokes the token. The
 *       token never leaves this function and is never stored. Not replay-
 *       guarded: a code is single-use at Discord, so a replayed body fails there.
 *   /api/discord/users                { ids: [...] }   → { users: { id: avatar_url|null } }
 *       Current avatars by user id through the bot (no guild in common needed),
 *       for prefs-api's scheduled refresh. An id Discord does not know is
 *       absent from `users`; null means the user has no custom avatar.
 *
 * Avatar URLs are static PNGs at 256px. A user without a custom avatar gets
 * null rather than Discord's default avatar, which is Discord's logo.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('discord-identity');

const DISCORD_API = 'https://discord.com/api/v10';

/** The only page allowed to receive a code. Discord also enforces its own registered list. */
const REDIRECT_URI = 'https://hadoku.me/account/link/callback';

const MAX_IDS = 100;
const SNOWFLAKE = /^\d{5,25}$/;
const STATE = /^[0-9a-f]{32,128}$/;

function configured() {
    return Boolean(process.env.CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function notConfigured() {
    return { status: 503, body: { success: false, error: 'oauth_not_configured' } };
}

function avatarUrl(id, hash) {
    if (!hash || !/^(a_)?[0-9a-f]{32}$/.test(hash)) return null;
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=256`;
}

function handleAuthorizeUrl(payload) {
    if (!configured()) return notConfigured();
    if (typeof payload.state !== 'string' || !STATE.test(payload.state)) {
        return { status: 400, body: { success: false, error: 'invalid_state' } };
    }
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.CLIENT_ID,
        scope: 'identify',
        state: payload.state,
        redirect_uri: REDIRECT_URI,
        prompt: 'consent',
    });
    return { status: 200, body: { success: true, url: `https://discord.com/oauth2/authorize?${q}` } };
}

function clientAuth() {
    const pair = `${process.env.CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`;
    return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function revoke(token, fetchFn) {
    // Expires on its own and is held nowhere, so a failed revoke is logged,
    // never fatal: failing the link would not un-issue the token.
    try {
        const res = await fetchFn(`${DISCORD_API}/oauth2/token/revoke`, {
            method: 'POST',
            headers: { Authorization: clientAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
        });
        if (!res.ok) log.warn('oauth_revoke_failed', { status: res.status });
    } catch (err) {
        log.warn('oauth_revoke_failed', { error: err.message });
    }
}

async function handleExchange(payload, { fetchFn = fetch } = {}) {
    if (!configured()) return notConfigured();
    if (typeof payload.code !== 'string' || !payload.code || payload.code.length > 512) {
        return { status: 400, body: { success: false, error: 'invalid_code' } };
    }
    const tokenRes = await fetchFn(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: clientAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: payload.code, redirect_uri: REDIRECT_URI }),
    });
    if (!tokenRes.ok) {
        // 400 invalid_grant: an expired or reused code, the user's to retry.
        log.fail('oauth_exchange_refused', { status: tokenRes.status });
        return {
            status: tokenRes.status === 400 ? 400 : 502,
            body: { success: false, error: tokenRes.status === 400 ? 'code_rejected' : 'discord_unavailable' },
        };
    }
    const token = (await tokenRes.json()).access_token;
    if (!token) return { status: 502, body: { success: false, error: 'no_access_token' } };
    try {
        const meRes = await fetchFn(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${token}` } });
        if (!meRes.ok) {
            log.fail('oauth_me_failed', { status: meRes.status });
            return { status: 502, body: { success: false, error: 'discord_unavailable' } };
        }
        const me = await meRes.json();
        if (typeof me.id !== 'string' || !SNOWFLAKE.test(me.id)) {
            return { status: 502, body: { success: false, error: 'no_user_id' } };
        }
        log.info('oauth_linked', { hasAvatar: Boolean(me.avatar) });
        return { status: 200, body: { success: true, id: me.id, avatar_url: avatarUrl(me.id, me.avatar) } };
    } finally {
        await revoke(token, fetchFn);
    }
}

async function handleUsers(payload, discordClient) {
    const ids = payload.ids;
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && SNOWFLAKE.test(id))) {
        return { status: 400, body: { success: false, error: 'invalid_ids' } };
    }
    const users = {};
    let unknown = 0;
    for (const id of new Set(ids)) {
        try {
            // force: the cached user can hold a hash from before their change.
            const user = await discordClient.users.fetch(id, { force: true });
            users[id] = avatarUrl(user.id, user.avatar);
        } catch (err) {
            // 10013 Unknown User: deleted. Absent from the answer, which the
            // caller reads as "keep what you have".
            if (err.code === 10013) {
                unknown++;
                continue;
            }
            throw err;
        }
    }
    log.info('users_resolved', { requested: ids.length, unknown });
    return { status: 200, body: { success: true, users } };
}

module.exports = { handleAuthorizeUrl, handleExchange, handleUsers, avatarUrl, REDIRECT_URI };
