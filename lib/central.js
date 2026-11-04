/**
 * The off-node lifecycle (hadoku-fleet-manager docs/service-state.md, "Off-node:
 * what the service must do"), so a hot standby on a second node can take over.
 *
 *   standby ──lease──▶ reconciling ──store == disk──▶ starting ──Discord ready──▶ active
 *
 * - STANDBY: another process holds the `state/` lease. Nothing is written and
 *   the bot does NOT log in to Discord: two logged-in copies would post every
 *   reminder twice. `/health` answers 503 `{detail: {central: {state}}}`, the
 *   shape hadoku_site's lease follower reads as "waiting" (mgmt-api
 *   deploy/health-check.ts `leaseRole`); every other route answers 503 too.
 * - RECONCILING: the lease is ours; the disk is made a working copy of the
 *   store (lib/reconcile.js). Still 503.
 * - STARTING: logging in to Discord. Still 503 (a waiting state).
 * - ACTIVE: 200 with `central: {state: "active", committed_s_ago}`.
 *
 * The lease is renewed every TTL/3 (lib/heldLease.js), and every store write
 * goes through the process fence (lib/dataStore.js): writes under `state/`
 * carry the token, and with the lease lost nothing is written at all. A lost
 * lease ends the process with LEASE_LOST_EXIT after destroying the Discord
 * client; PM2 starts it again, as a standby.
 *
 * `ARCHIVEBOT_STATE_STORE` unset or `local`: none of this runs and the bot keeps
 * its state on this node, as before (the contract's item 2). `HADOKU_DATA_URL`
 * alone is not the switch: the on-node bot already uses it for the import, and
 * flipping on it would turn the lease on with a deploy rather than a cutover.
 */
const os = require('os');
const { DataStore, isLeaseHeld } = require('./dataStore');
const { HeldLease } = require('./heldLease');
const { CentralRefusal, STATE_PREFIX } = require('./reconcile');
const { createLogger } = require('../utils/logger');

const log = createLogger('central');

const LEASE_TTL_S = 30;
const STANDBY_POLL_MS = 5000;
/** EX_TEMPFAIL, as watchparty: PM2 restarts it, and it comes back as the standby. */
const LEASE_LOST_EXIT = 75;

/** Central mode from the environment: false (on-node) or true. Throws on a bad setting. */
function centralMode(env = process.env) {
    const mode = (env.ARCHIVEBOT_STATE_STORE || '').trim() || 'local';
    if (mode === 'local') return false;
    if (mode !== 'central') throw new Error(`ARCHIVEBOT_STATE_STORE must be 'local' or 'central', got '${mode}'`);
    if (!env.HADOKU_DATA_URL || !env.HADOKU_SERVICE_KEY) {
        throw new Error('ARCHIVEBOT_STATE_STORE=central needs HADOKU_DATA_URL and HADOKU_SERVICE_KEY');
    }
    return true;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });

class Central {
    /**
     * @param {object} opts
     * @param {DataStore} opts.ds   unfenced: reconcile reads, the lease itself
     * @param {(why: string) => void} [opts.onLost]  set later via `central.onLost`
     */
    constructor({ ds, ttlS = LEASE_TTL_S, pollMs = STANDBY_POLL_MS, holder = os.hostname(), onLost = null }) {
        this.ds = ds;
        this.pollMs = pollMs;
        this.holder = holder;
        this.onLost = onLost;
        this.state = 'standby';
        this.reason = null;
        this.lastCommit = null;
        this.stopping = false;
        this.lease = new HeldLease(ds, STATE_PREFIX, { ttlS, holder, onLost: (why) => this._lost(why) });
    }

    phase() {
        return this.state;
    }

    /** `/health`'s `central` block. */
    status() {
        const out = { state: this.state, holder: this.holder };
        if (this.reason) out.reason = this.reason;
        if (this.lastCommit !== null) out.committed_s_ago = Math.round((Date.now() - this.lastCommit) / 1000);
        return out;
    }

    /** The live token, or null: a standby or a holder that lost the lease writes nothing. */
    token() {
        return this.lease.held ? this.lease.token : null;
    }

    /** What every fenced DataStore carries (DataStore.setProcessFence). */
    fence() {
        return {
            prefix: STATE_PREFIX,
            token: () => this.token(),
            onRefused: (why) => this.lease.markLost(why),
        };
    }

    _lost(why) {
        this.state = 'lost';
        this.reason = why;
        log.warn('leaseLost', { holder: this.holder, why });
        if (this.onLost) this.onLost(why);
    }

    /**
     * Wait for the lease; resolves once it is ours. Another holder is the
     * normal standby case and is retried quietly; anything else (the store
     * unreachable, the key unbound) is logged once per kind of failure.
     */
    async acquire() {
        let lastWhy = null;
        for (;;) {
            if (this.stopping) throw new Error('stopped while waiting for the lease');
            try {
                await this.lease.acquire();
                log.success('lease_acquired', { prefix: STATE_PREFIX, holder: this.holder, token: this.lease.token });
                return this.lease.token;
            } catch (err) {
                const why = isLeaseHeld(err) ? 'held by another process' : err.message;
                if (why !== lastWhy) {
                    if (isLeaseHeld(err)) log.info('standby', { reason: why });
                    else log.warn('lease_unavailable', { error: why });
                    lastWhy = why;
                }
            }
            await sleep(this.pollMs);
        }
    }

    /**
     * Run `fn(ds)` (the reconcile) under the lease. A CentralRefusal hands the
     * lease back and rethrows: the process must not serve.
     */
    async reconcile(fn) {
        this.state = 'reconciling';
        try {
            const result = await fn(this.ds);
            this.state = 'starting';
            this.lastCommit = Date.now();
            return result;
        } catch (err) {
            this.state = err instanceof CentralRefusal ? 'refused' : 'failed';
            this.reason = err.message;
            await this.lease.release().catch((e) => log.warn('release', { error: e.message }));
            throw err;
        }
    }

    /** Discord is ready: this process serves. */
    serving() {
        if (this.state === 'starting') this.state = 'active';
    }

    /** A state pass left nothing behind. */
    committed() {
        this.lastCommit = Date.now();
    }

    /** Stop waiting, stop renewing, hand the lease back. */
    async stop() {
        this.stopping = true;
        if (this.state !== 'lost') this.state = 'standby';
        await this.lease.release();
    }
}

/**
 * The lease is gone: stop every writer, drop the Discord session, exit so PM2
 * starts this again as a standby. Synchronous up to the exit: nothing this
 * process still has queued may run as if it held the lease.
 */
function handleLeaseLost({ why, stopWriters, client, server, exit = process.exit }) {
    log.error('lease_lost_exit', new Error(why), { exitCode: LEASE_LOST_EXIT });
    try {
        stopWriters();
    } finally {
        try {
            client.destroy();
        } finally {
            if (server) server.close();
            exit(LEASE_LOST_EXIT);
        }
    }
}

/**
 * Boot in central mode: the lease, then the reconcile, then (and only then)
 * the Discord login. Resolves once `login` has; rejects on a refusal.
 */
async function bootCentral({ central, reconcile, login }) {
    await central.acquire();
    const result = await central.reconcile(reconcile);
    log.success('reconciled', result);
    await login();
    return result;
}

module.exports = { Central, centralMode, bootCentral, handleLeaseLost, LEASE_TTL_S, LEASE_LOST_EXIT, STANDBY_POLL_MS };
