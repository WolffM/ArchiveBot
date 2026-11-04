/**
 * A dataplatform lease held for as long as the process serves, renewed in the
 * background at a third of its TTL. The JavaScript twin of the endpoint's own
 * `client.HeldLease` (hadoku-dataplatform server/dataplatform/data/client.py)
 * and of watchparty's `central/heldLease.ts`, with the same two rules for when
 * it is LOST:
 *
 * - a renewal is refused (`lease_lost`): the lease lapsed, someone may hold it;
 * - no renewal has been confirmed for a whole TTL, whatever the renewals were
 *   failing with. By then the lease has lapsed on the server whether or not
 *   anyone said so.
 *
 * The second rule runs on its own timer, not inside a renewal: a renewal that
 * hangs on a dead network would otherwise hold the verdict back for as long as
 * its request timeout, and this bot's Discord session is NOT fenced by the
 * store. A holder that went on believing it would post every reminder a second
 * time beside the standby that took over.
 *
 * Expiry is measured from when each request was SENT: the server counts from
 * when it received it, never earlier. A lost lease is never renewed back to
 * life (the endpoint refuses that too).
 */
const { DataStore, isLeaseLost } = require('./dataStore');

class HeldLease {
    /**
     * @param {DataStore} ds          the store (its url, key and namespace)
     * @param {string} prefix         what the lease covers, e.g. `state/`
     * @param {object} opts
     * @param {number} opts.ttlS      seconds, 1-600
     * @param {string} [opts.holder]  shown by `GET /lease` (the node's name)
     * @param {(why: string) => void} [opts.onLost]  called once, the moment it is lost
     * @param {() => number} [opts.now]  monotonic ms, for tests
     */
    constructor(ds, prefix, { ttlS, holder, onLost, now } = {}) {
        if (!(ttlS >= 1 && ttlS <= 600)) throw new Error(`lease ttl must be 1-600 s, got ${ttlS}`);
        this.ds = ds;
        this.prefix = prefix;
        this.ttlMs = ttlS * 1000;
        this.holder = holder;
        this.onLost = onLost;
        this.now = now || (() => performance.now());
        this.token = null;
        this.lostWhy = null;
        this.confirmed = 0;
        this.stopped = false;
        this.renewTimer = null;
        this.watchdog = null;
        // Renewals on their own connection, timed out and retried well inside
        // the TTL: the next renewal is the retry.
        const step = Math.max(500, this.ttlMs / 3);
        this.renewer = new DataStore({ url: ds.base.href, key: ds.key, ns: ds.ns, timeoutMs: step, retryWindowMs: step });
    }

    /** Why it was lost, or null while held (or not yet taken). */
    get lost() {
        return this.lostWhy;
    }

    /** True while the lease is ours and live. */
    get held() {
        return this.token !== null && !this.lostWhy && !this.stopped;
    }

    /**
     * Take the lease, then keep it. Rejects with a `lease_held` DataError while
     * another process holds it: this one is the standby.
     */
    async acquire() {
        const sent = this.now();
        const grant = await this.ds.acquireLease(this.prefix, { ttl: this.ttlMs / 1000, holder: this.holder });
        this.token = grant.token;
        this.confirmed = sent;
        this._schedule();
        this.watchdog = setInterval(() => this._checkExpiry('no answer'), Math.min(1000, this.ttlMs / 4));
        this.watchdog.unref();
        return this.token;
    }

    _schedule() {
        if (this.stopped || this.lostWhy) return;
        this.renewTimer = setTimeout(() => this._renew(), this.ttlMs / 3);
        // The bot keeps the process alive; a lease alone must not.
        this.renewTimer.unref();
    }

    _checkExpiry(last) {
        if (this.stopped || this.lostWhy) return;
        if (this.now() - this.confirmed >= this.ttlMs) {
            this.markLost(`no renewal confirmed for a whole ${this.ttlMs / 1000}s TTL (last: ${last})`);
        }
    }

    /** Lost, for any reason (a renewal, a refused write). Idempotent. */
    markLost(why) {
        if (this.lostWhy || this.stopped) return;
        this.lostWhy = why;
        this._clearTimers();
        this.renewer.close();
        if (this.onLost) this.onLost(why);
    }

    _clearTimers() {
        if (this.renewTimer) clearTimeout(this.renewTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        this.renewTimer = null;
        this.watchdog = null;
    }

    async _renew() {
        if (this.stopped || this.lostWhy || this.token === null) return;
        const sent = this.now();
        try {
            await this.renewer.acquireLease(this.prefix, { ttl: this.ttlMs / 1000, token: this.token });
            this.confirmed = sent;
        } catch (err) {
            if (isLeaseLost(err)) {
                this.markLost(`renewal refused: ${err.message}`);
                return;
            }
            this._checkExpiry(err.message);
        }
        this._schedule();
    }

    /** Stop renewing and hand the lease back. Not after it was lost: it is not ours. */
    async release() {
        if (this.stopped) return;
        this.stopped = true;
        this._clearTimers();
        this.renewer.close();
        if (this.lostWhy || this.token === null) return;
        try {
            await this.ds.releaseLease(this.prefix, this.token);
        } catch (err) {
            if (!isLeaseLost(err)) throw err;
        }
    }
}

module.exports = { HeldLease };
