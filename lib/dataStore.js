/**
 * Client for dataplatform's fleet data endpoint (`HADOKU_DATA_URL`).
 *
 * A port of the parts of hadoku-dataplatform's `server/dataplatform/data/client.py`
 * this bot uses; the contract is that repo's `server/dataplatform/data/AGENTS.md`.
 * Every request carries `X-User-Key` (the bot's own service key), and the key's
 * binding pins it to one namespace (`archivebot`).
 *
 * - Bodies always go with `Content-Length`; the store answers chunked with 411.
 * - `putFile` streams from disk and sends `X-Content-Sha256`, so a damaged
 *   upload is refused (422) rather than stored.
 * - A refused connection or reset is retried for a few seconds: a dataplatform
 *   deploy drops the listener for about a second, and that is not a failure.
 * - A `fence` (lib/central.js) makes every write lease-bound: a write under
 *   the lease's prefix carries `X-Lease-Token`, and with no live lease no write
 *   leaves the process at all. A write the store refuses as `lease_lost`
 *   reports itself to the fence, which ends the process.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const RETRY_WINDOW_MS = 5000;
const RETRY_STEP_MS = 250;
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

class DataError extends Error {
    constructor(status, body, message) {
        super(message);
        this.name = 'DataError';
        this.status = status;
        this.body = body;
        // The store's own refusal code (`lease_lost`, `lease_held`), when it sent one.
        this.reason = body?.code || null;
    }
}

/** 409 lease_lost: the token is no longer the live lease. Stop writing. */
function isLeaseLost(err) {
    return err instanceof DataError && err.status === 409 && err.reason === 'lease_lost';
}

/** 409 lease_held: someone else holds it. This process is the standby. */
function isLeaseHeld(err) {
    return err instanceof DataError && err.status === 409 && err.reason === 'lease_held';
}

/** A write this process refused to send: it does not hold the lease. */
class LeaseNotHeld extends Error {
    constructor(key) {
        super(`write ${key} not sent: this process does not hold the lease`);
        this.name = 'LeaseNotHeld';
    }
}

function encodeKey(key) {
    return key.split('/').map(encodeURIComponent).join('/');
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

function recordFromHeaders(headers) {
    return {
        size: Number(headers['content-length']),
        version: headers.etag ? Number(headers.etag.replace(/"/g, '')) : null,
        sha256: headers['x-content-sha256'] || null,
        contentType: headers['content-type'] || null,
    };
}

class DataStore {
    /**
     * `fence`: `{prefix, token(), onRefused(why)}` (lib/central.js). Unset, writes
     * go unfenced: on-node mode, and the offline tools.
     */
    constructor({ url, key, ns, timeoutMs = 120000, fence = null, retryWindowMs = RETRY_WINDOW_MS }) {
        if (!url || !key || !ns) throw new Error('DataStore needs url, key and ns');
        this.base = new URL(url);
        this.key = key;
        this.ns = ns;
        this.timeoutMs = timeoutMs;
        this.fence = fence;
        this.retryWindowMs = retryWindowMs;
        this.agent = new http.Agent({ keepAlive: true });
    }

    /**
     * From `HADOKU_DATA_URL` and `HADOKU_SERVICE_KEY`, the names client.py reads.
     * Carries the process's fence once lib/central.js has set one, so no writer
     * in the bot reaches the store without the lease.
     */
    static fromEnv(ns = 'archivebot') {
        return new DataStore({ url: process.env.HADOKU_DATA_URL, key: process.env.HADOKU_SERVICE_KEY, ns, fence: DataStore.processFence });
    }

    /** The fence every later `fromEnv()` store carries (null: unfenced). */
    static setProcessFence(fence) {
        DataStore.processFence = fence;
    }

    static configured() {
        return Boolean(process.env.HADOKU_DATA_URL && process.env.HADOKU_SERVICE_KEY);
    }

    close() {
        this.agent.destroy();
    }

    _path(key, query = '') {
        return `/data/${this.ns}/${encodeKey(key)}${query}`;
    }

    /**
     * One request. `body` is a Buffer, or a function returning a fresh readable
     * stream (a retry needs a new one). Resolves `{status, headers, body}`; the
     * body is only collected when `collect` is set.
     */
    _once(method, path, { headers = {}, body, length, collect = true }) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: this.base.hostname,
                port: this.base.port,
                method,
                path,
                agent: this.agent,
                timeout: this.timeoutMs,
                headers: { 'X-User-Key': this.key, ...headers, ...(length !== undefined ? { 'Content-Length': length } : {}) },
            });
            let answered = false;
            req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
            req.on('error', (err) => {
                // The store closes the connection after refusing a body it never
                // read; the refusal itself has already arrived.
                if (!answered) reject(err);
            });
            req.on('response', (res) => {
                answered = true;
                const chunks = [];
                res.on('data', (c) => { if (collect) chunks.push(c); });
                res.on('error', reject);
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            });
            if (typeof body === 'function') {
                const stream = body();
                stream.on('error', (err) => req.destroy(err));
                stream.pipe(req);
            } else {
                req.end(body);
            }
        });
    }

    async _request(method, path, opts = {}) {
        const deadline = Date.now() + this.retryWindowMs;
        for (;;) {
            let res;
            try {
                res = await this._once(method, path, opts);
            } catch (err) {
                if (TRANSIENT.has(err.code) && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, RETRY_STEP_MS));
                    continue;
                }
                throw err;
            }
            if (res.status === 503 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, RETRY_STEP_MS));
                continue;
            }
            return res;
        }
    }

    static _raise(res, what) {
        let body = null;
        try {
            body = JSON.parse(res.body.toString('utf8'));
        } catch {
            body = { error: res.body.toString('utf8').slice(0, 200) };
        }
        const detail = body?.code || body?.error || '';
        throw new DataError(res.status, body, `${what}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }

    /**
     * The fence's headers for a write to `key`. Throws, sending nothing, when a
     * fence is set and its lease is not live: a standby, or a holder that lost
     * the lease, never writes, under the prefix or outside it.
     */
    _fenceHeaders(key) {
        if (!this.fence) return {};
        const token = this.fence.token();
        if (token === null || token === undefined) throw new LeaseNotHeld(key);
        return key.startsWith(this.fence.prefix) ? { 'X-Lease-Token': String(token) } : {};
    }

    /** A write's answer: the record, or a raise. A `lease_lost` refusal tells the fence first. */
    _written(res, what) {
        if (res.status === 200 || res.status === 201) return JSON.parse(res.body.toString('utf8'));
        try {
            DataStore._raise(res, what);
        } catch (err) {
            if (isLeaseLost(err) && this.fence) this.fence.onRefused(`${what} refused: ${err.message}`);
            throw err;
        }
        return null;
    }

    static _writeHeaders({ createOnly, ifMatch, contentType, sha256 }) {
        const h = {};
        if (createOnly) h['If-None-Match'] = '*';
        if (ifMatch !== undefined && ifMatch !== null) h['If-Match'] = `"${ifMatch}"`;
        if (contentType) h['Content-Type'] = contentType;
        if (sha256) h['X-Content-Sha256'] = sha256;
        return h;
    }

    /** `{size, version, sha256, contentType}`, or null when absent. */
    async head(key) {
        const res = await this._request('HEAD', this._path(key), { collect: false });
        if (res.status === 404) return null;
        if (res.status !== 200) DataStore._raise(res, `HEAD ${key}`);
        return recordFromHeaders(res.headers);
    }

    /** `{body, ...record}`, or null when absent. */
    async get(key) {
        const res = await this._request('GET', this._path(key));
        if (res.status === 404) return null;
        if (res.status !== 200) DataStore._raise(res, `GET ${key}`);
        return { body: res.body, ...recordFromHeaders(res.headers), size: res.body.length };
    }

    /**
     * PUT bytes. A PUT needs a precondition: `createOnly` (412 if it exists) or
     * `ifMatch: <version>` (compare-and-swap).
     */
    async put(key, data, { createOnly = false, ifMatch, contentType } = {}) {
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const sha256 = crypto.createHash('sha256').update(body).digest('hex');
        const res = await this._request('PUT', this._path(key), {
            headers: { ...DataStore._writeHeaders({ createOnly, ifMatch, contentType, sha256 }), ...this._fenceHeaders(key) },
            body,
            length: body.length,
        });
        return this._written(res, `PUT ${key}`);
    }

    /** PUT a file, streamed from disk, refused by the store if its hash differs. */
    async putFile(key, filePath, { createOnly = false, ifMatch, contentType, sha256 } = {}) {
        const fenced = this._fenceHeaders(key);
        const digest = sha256 || await sha256File(filePath);
        const { size } = fs.statSync(filePath);
        const res = await this._request('PUT', this._path(key), {
            headers: { ...DataStore._writeHeaders({ createOnly, ifMatch, contentType, sha256: digest }), ...fenced },
            body: () => fs.createReadStream(filePath),
            length: size,
        });
        return this._written(res, `PUT ${key}`);
    }

    /**
     * Append `data` to an existing record exactly once. A plain append that is
     * retried after its connection died may already have landed, and would
     * land twice. This one is swapped against the version read first; when it
     * is refused, the bytes appended since that read show whether it landed
     * (appends only grow a record). Another writer's append in between is
     * contention: read again and retry. Returns null when the record is absent.
     */
    async appendOnce(key, data, { attempts = 5 } = {}) {
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
        for (let i = 0; i < attempts; i++) {
            const before = await this.head(key);
            if (!before) return null;
            try {
                return await this.append(key, body, { ifMatch: before.version });
            } catch (err) {
                if (!(err instanceof DataError && err.status === 412)) throw err;
            }
            const now = await this.get(key);
            if (now && now.body.subarray(before.size).includes(body)) return { version: now.version, size: now.size };
        }
        throw new DataError(412, null, `append ${key}: still contended after ${attempts} attempts`);
    }

    /** Atomic append (≤ 1 MiB a call); creates the record if absent. `ifMatch` makes it conditional. */
    async append(key, data, { ifMatch } = {}) {
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const res = await this._request('POST', this._path(key, '?append'), {
            headers: { ...DataStore._writeHeaders({ ifMatch }), ...this._fenceHeaders(key) },
            body,
            length: body.length,
        });
        return this._written(res, `append ${key}`);
    }

    /** Tombstone one record, compare-and-swap on `ifMatch`. False when it was already absent. */
    async delete(key, { ifMatch } = {}) {
        const res = await this._request('DELETE', this._path(key), {
            headers: { ...DataStore._writeHeaders({ ifMatch }), ...this._fenceHeaders(key) },
            length: 0,
        });
        if (res.status === 404) return false;
        this._written(res, `DELETE ${key}`);
        return true;
    }

    /**
     * Everything written after `since`, tombstones included, oldest first, and
     * the cursor to pass next time: `{changes, cursor}`. A cache revalidates
     * with this instead of reading everything again.
     */
    async changes(since = 0, { limit = 1000 } = {}) {
        const out = [];
        let cursor = since;
        for (;;) {
            const q = new URLSearchParams({ since: String(cursor), limit: String(limit) });
            const res = await this._request('GET', this._path('', `?changes&${q}`));
            if (res.status !== 200) DataStore._raise(res, 'changes');
            const doc = JSON.parse(res.body.toString('utf8'));
            out.push(...doc.changes);
            cursor = doc.cursor;
            if (!doc.more) return { changes: out, cursor };
        }
    }

    /**
     * Acquire a lease over `prefix`, or renew it with `token`. Resolves
     * `{token, expires_in, ...}`; 409 `lease_held` (another holder) and
     * `lease_lost` (the token lapsed) raise.
     */
    async acquireLease(prefix, { ttl, holder, token } = {}) {
        const payload = { ttl };
        if (holder) payload.holder = holder;
        if (token !== undefined && token !== null) payload.token = String(token);
        const body = Buffer.from(JSON.stringify(payload));
        const res = await this._request('POST', `/lease/${this.ns}/${encodeKey(prefix)}`, {
            headers: { 'Content-Type': 'application/json' },
            body,
            length: body.length,
        });
        if (res.status !== 200) DataStore._raise(res, `lease ${prefix}`);
        const doc = JSON.parse(res.body.toString('utf8'));
        return { ...doc, token: Number(doc.token) };
    }

    /** Hand a lease back. A lapsed one raises `lease_lost`. */
    async releaseLease(prefix, token) {
        const res = await this._request('DELETE', `/lease/${this.ns}/${encodeKey(prefix)}`, {
            headers: { 'X-Lease-Token': String(token) },
            length: 0,
        });
        if (res.status !== 200) DataStore._raise(res, `release ${prefix}`);
    }

    /** `{held, holder?, expires_in?}` for `prefix`. */
    async leaseInfo(prefix) {
        const res = await this._request('GET', `/lease/${this.ns}/${encodeKey(prefix)}`);
        if (res.status !== 200) DataStore._raise(res, `lease ${prefix}`);
        return JSON.parse(res.body.toString('utf8'));
    }

    /** Every record under `prefix`, in key order, a page at a time. */
    async *list(prefix = '', { limit = 1000 } = {}) {
        let after = null;
        for (;;) {
            const q = new URLSearchParams({ limit: String(limit) });
            if (after) q.set('after', after);
            const res = await this._request('GET', this._path(prefix, `?list&${q}`));
            if (res.status !== 200) DataStore._raise(res, `list ${prefix}`);
            const page = JSON.parse(res.body.toString('utf8'));
            yield* page.items;
            if (!page.next) return;
            after = page.next;
        }
    }
}

DataStore.processFence = null;

module.exports = { DataStore, DataError, LeaseNotHeld, isLeaseLost, isLeaseHeld, sha256File, encodeKey };
