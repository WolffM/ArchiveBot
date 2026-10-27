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
    constructor({ url, key, ns, timeoutMs = 120000 }) {
        if (!url || !key || !ns) throw new Error('DataStore needs url, key and ns');
        this.base = new URL(url);
        this.key = key;
        this.ns = ns;
        this.timeoutMs = timeoutMs;
        this.agent = new http.Agent({ keepAlive: true });
    }

    /** From `HADOKU_DATA_URL` and `HADOKU_SERVICE_KEY`, the names client.py reads. */
    static fromEnv(ns = 'archivebot') {
        return new DataStore({ url: process.env.HADOKU_DATA_URL, key: process.env.HADOKU_SERVICE_KEY, ns });
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
        const deadline = Date.now() + RETRY_WINDOW_MS;
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
            headers: DataStore._writeHeaders({ createOnly, ifMatch, contentType, sha256 }),
            body,
            length: body.length,
        });
        if (res.status !== 200 && res.status !== 201) DataStore._raise(res, `PUT ${key}`);
        return JSON.parse(res.body.toString('utf8'));
    }

    /** PUT a file, streamed from disk, refused by the store if its hash differs. */
    async putFile(key, filePath, { createOnly = false, ifMatch, contentType, sha256 } = {}) {
        const digest = sha256 || await sha256File(filePath);
        const { size } = fs.statSync(filePath);
        const res = await this._request('PUT', this._path(key), {
            headers: DataStore._writeHeaders({ createOnly, ifMatch, contentType, sha256: digest }),
            body: () => fs.createReadStream(filePath),
            length: size,
        });
        if (res.status !== 200 && res.status !== 201) DataStore._raise(res, `PUT ${key}`);
        return JSON.parse(res.body.toString('utf8'));
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
            headers: DataStore._writeHeaders({ ifMatch }),
            body,
            length: body.length,
        });
        if (res.status !== 200 && res.status !== 201) DataStore._raise(res, `append ${key}`);
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

module.exports = { DataStore, DataError, sha256File, encodeKey };
