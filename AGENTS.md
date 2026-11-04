# CLAUDE.md - ArchiveBot

## What this is

Discord bot (discord.js v14, Node.js, SQLite). Features: message archiving, task management, color roles, permissions, reminders/events.

Local PM2 service (runs on the developer's Windows/WSL machine, not a remote server). Deployed via push to `main` → GitHub Actions `repository_dispatch` to `WolffM/hadoku_site` → self-hosted runner on the same machine → `git pull` + `pnpm install --frozen-lockfile` + `pm2 restart archive-bot`. The build command lives in `../hadoku_site/services/mgmt-api/deploy-config.json`, not here — a new dependency needs its lockfile change committed or the deploy fails on the frozen lockfile. The `hadoku.me` domain is a Cloudflare tunnel back to localhost.

## Command definitions

Slash commands defined in `commands.js`, routed from `index.js`.

Option types: 3=STRING, 4=INTEGER, 5=BOOLEAN, 6=USER, 7=CHANNEL, 11=ATTACHMENT

For CHANNEL type, use `channel_types: [2, 13]` to filter to voice/stage channels.

## Key patterns

- Guild config: `Output/Resources/{guildId}/` — permissions, color roles (under the output root, so it is state)
- Guild output: `Output/{guildId}/` — archives, scheduled items
- Task data: `Output/tasklist/{guildId}/`
- `Output/` is the default root; every output path goes through `lib/paths.js` (`outputPath()`), never a literal `'Output'`
- Permissions: `permissions.hasAdminAccess(guildId, userId)` / `permissions.hasTaskAccess(guildId, userId)`
- Time parsing: `parseRelativeTime()` / `parseDateTime()` in `lib/scheduler.js`
- Graceful shutdown: SIGTERM/SIGINT handlers in `index.js`
- Slash commands auto-register on PM2 start/restart

## External dependencies

- Discord API via discord.js
- Deploy: `.github/workflows/deploy.yml` → repository dispatch to `WolffM/hadoku_site`
- `hosting.json` — the bot's hosting request to hadoku-fleet-manager (moving to claw-4,
  hadoku-fleet-manager-private#136). Validate edits with `fleet hosting-request ./hosting.json`;
  `coldStartS` covers a fresh host's restore from the store (archive.db rebuild: 68 s on hokon).
  `isolation.advisoryUntil: 0` makes `ciMayRead: false` a hard filter: no claw is offered until its CI
  runs as its own user, because a CI job must never be able to read the bot.
- dataplatform's fleet data endpoint (`HADOKU_DATA_URL`), namespace `archivebot` — the archive's
  system of record. See **Archive storage**.

## Environment variables

In production these are injected by the PM2 wrapper from the vault — see **Auth
& secrets** below. `.env` (via `dotenv`) is a local-dev convenience only, and it
is read only while `HADOKU_DATA_URL` is unset: the wrapper always sets that, so a
node-local `.env` can never fill in a setting in production (a standby on another
node would not have it). The wrapper's `vaultKeys` map in
`../hadoku_site/services/pm2/archive-bot-wrapper.mjs` is the authoritative list.

Core:
- `DISCORD_TOKEN` — bot token
- `CLIENT_ID` — application ID

Webhook server. The server starts if ANY route is fully configured; a route
whose config is missing answers 404 rather than taking the others down. With
none configured it does not start at all (except in central mode, where it always
listens). `GET /health` (unauthenticated) answers
`{status, commit, discord}`, 200 while the Discord session is ready, 503 while not;
`commit` is the checkout's HEAD, which hadoku_site's deploy and service move check.
In central mode it follows the lease: see **Central mode**.
- `ARCHIVEBOT_EVENTS_WEBHOOK_SECRET` — HMAC for `/api/events/*` and `/api/messages/send`, shared with rally-api
- `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` — cardtable's own HMAC on the same four routes, plus
  `GET /api/messages/recent`; see **cardtable guild**.
  Unset = cardtable-signed requests 401; meet is unaffected.
- `ARCHIVEBOT_PREFS_WEBHOOK_SECRET` — hadoku_site prefs-api's HMAC on `/api/discord/*` (Discord
  identity for hadoku avatars: consent URL, code exchange, current avatars by id; `lib/discordIdentity.js`;
  and linked members' role + nickname in the cardtable guild, `lib/cardtableMembers.js`).
  Unset = those routes 404.
- `DISCORD_CLIENT_SECRET` — this application's OAuth2 client secret, for the code exchange. Unset =
  Discord linking answers 503 (avatar lookups by id still work: they use the bot token). Every
  Discord credential in the ecosystem lives here; prefs-api holds none.
- `ARCHIVEBOT_EVENT_GUILD_ID` / `ARCHIVEBOT_EVENT_CHANNEL_ID` — where webhook-created events land and announce
- `WEBHOOK_PORT` — defaults to 3004

Telemetry (see **Notifications & telemetry**):
- `MONITORING_SERVICE_KEY` — monitoring service-tier key. Unset = the ledger mirror is a no-op.
- `MONITORING_TELEMETRY_URL` — defaults to `https://hadoku.me/health/api/telemetry`

Other:
- `ARCHIVEBOT_OUTPUT_DIR` — root for ALL output (archives, attachments, scheduler/sent/spaces/
  cardtable state, per-guild config in `Resources/`, tasklist, log.csv). Defaults to `Output/` in the checkout. When set, it
  must already exist: the bot refuses to start rather than recreate it, because a missing
  root means its disk is unmounted and the mount point is an empty dir on `/`.
- `HADOKU_DATA_URL` / `HADOKU_SERVICE_KEY` — dataplatform's data endpoint and the bot's service key.
  Both set = the importer runs. Either unset = it doesn't.
- `ARCHIVEBOT_STATE_STORE` — `local` (default) or `central`. `central` needs both of the above and
  turns on the lease, the takeover reconcile and the standby; see **Central mode**.
- `LOG_LEVEL` — `DEBUG|INFO|WARN|ERROR` (case-insensitive), defaults to `INFO`.
  An unrecognised value falls back to `INFO` rather than silencing the service.

GitHub secret: `HADOKU_SITE_TOKEN` (deploy workflow)

## Notifications & telemetry

Three conventions, all ecosystem-wide. Follow them when adding a send site.

**Mentions are opt-in.** `utils/clientOptions.js` sets a client-level
`allowedMentions: { parse: [] }`, so nothing pings by default. This bot relays
strings it did not write — task titles, scraped event titles, upstream error
text — and Discord's own default parses every mention it finds. A code fence
does NOT suppress one. To mention deliberately, pass a per-message
`allowedMentions` (it replaces the default), as `lib/scheduler.js` does.

**Failures report themselves.** `lib/ledger.js` mirrors into monitoring-api's
`service_events`, in two namespaces:

- `mirrorToLedger('archivebot.*', …)` — activity, level `info`. The bot doing
  its job. Lands in the events feed, counts toward nothing.
- `mirrorFailureToLedger('archivebot.*', …)` — emits `event=alert.archivebot.*`
  at level `error`, the same shape as mgmt-api's `alert.mgmt.<source>`. Reserved
  for **a notification somebody was owed that did not happen**: a reminder that
  could not fire, an accepted webhook whose message never posted, an event that
  could not be created or cancelled.

Do NOT alert on a refused request — a bad signature or an unparseable payload is
the caller's bug, already answered with a 4xx, and alerting on it drowns the real
thing. Both mirrors are fire-and-forget: telemetry must never delay or fail a
notification.

**Logs are `key=val`, and failures carry `event=`.** `utils/logger.js` is a thin
adapter over `@wolffm/logger/server`, the shared ecosystem logger. Call sites keep
`createLogger(module)` and its six methods; the module becomes a nested service
label:

```
[2026-08-19T20:10:19.461Z] [INFO]  [archive-bot/bot]       guilds=4 status=SUCCESS ready
[2026-08-19T20:06:58.577Z] [ERROR] [archive-bot/scheduler] itemId=15 error="…" event=fire_item
```

- `log.error(action, err, details)` emits `event=<action>` at ERROR — snake_cased,
  because that token is a grep target shared with every other hadoku service.
  `grep event=` across all service logs finds every backend failure.
- `log.fail()` is a REFUSED request (permission denied, bad input), not an
  operational failure. It stays at INFO carrying `status=FAILED`.
- `log.success()` carries `status=SUCCESS`. Both survive from the old JSON format,
  where status was the only way to tell them apart.

Two things to know when touching this. `@wolffm/logger` is ESM-only and this
codebase is CommonJS — `require()` of it works because Node 22.12+ supports it and
PM2 runs the bot on node 22.14, so **verify against `/usr/local/bin/node`, not
whatever `node` is on your PATH**. And Jest's CJS runtime *cannot* require ESM,
which is the only reason `babel.config.js` and the `transformIgnorePatterns` entry
in `jest.config.js` exist.

The logger's optional `telemetrySink` is deliberately NOT wired: `lib/ledger.js`
above already reports failures to monitoring-api under a curated namespace, and
mirroring every ERROR as well would both duplicate those and bury them.

## cardtable guild

`/setup layout:cardtable` (admin; the guild owner always counts as admin) converges a
guild onto hadoku-cardtable's layout: Info (#announcements, #events, both read-only),
Table (#general, #looking-for-game, #bugs-and-feedback), Voice (Table 1, Table 2), the
Player, Admin and Linked roles, and a permanent invite whose joins get Player. Safe to re-run;
on failure it deletes what that run created. `lib/cardtableSetup.js`.

A successful run writes `Output/{guildId}/cardtable.json`, and that file IS the binding:
a request signed with `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` is pinned to that guild
(another `guild_id` → 403), messages default to #announcements and event announcements
to #events, and only that caller may send `embeds` on `/api/messages/send`
(validated subset in `lib/messageWebhook.js` `validateEmbeds`). The setup refuses to
bind a second guild.

**Linked members.** The same file's `links` maps a Discord user id to the hadoku display
name of the account it is linked to. prefs-api writes it with `POST /api/discord/members/sync
{set: [{id, name}], remove: [id]}` (≤100 each, prefs secret): on link, on unlink, and in
batches from its daily avatar refresh, which carries renames. A linked member gets the
**Linked** role and that name as their server nickname; unlink takes the role away and
clears the nickname only if it is still ours. A link stored before the person joins is
applied on `guildMemberAdd`, and a `/setup` run applies every stored link. Discord never
lets a bot rename the guild owner or anyone above the bot's role: those get the role and
keep their nickname. The bot needs **Manage Nicknames** (the setup refuses without it).
`lib/cardtableMembers.js`.

`GET /api/messages/recent?channel=general&limit=5` takes cardtable's secret only (rally-api has no business reading
that chat), signed as an HMAC over the raw query string. It answers the bound guild's
#general (no other channel, ever) as `{messages: [{author, avatar, color, text, at}]}`, oldest first,
at most 10, bots/system/empty skipped, as plain text with every `<…>` id token
resolved or replaced and URLs/spoilers hidden (`lib/recentMessages.js`). `avatar` is the
author's guild avatar (else profile, else Discord's default) inlined as a 64px `data:` URI,
null if the CDN fails; `color` is their name's role colour `#rrggbb`, null without one.
It feeds cardtable's front page, which draws it as Discord does, so nothing in it may
link back: never an id, and never a CDN URL (it carries the user id, and hadoku.me's
CSP admits `data:` images, not Discord's CDN).

## Archive storage

The archive's system of record is dataplatform's data endpoint, namespace `archivebot`
(contract: `hadoku-dataplatform/server/dataplatform/data/AGENTS.md`). `lib/dataStore.js` is the
client, a port of that repo's `client.py`. Keys carry ids only; names live in the records:

```
<guild>/<channel>/batches/<ms>.json                    archive_<ms>.json, immutable
<guild>/<channel>/authors/<ms>.json                    authors_<ms>.json, immutable
<guild>/<channel>/attachments/<message>/<attachment>   one per recorded attachment
<guild>/<channel>/attachments-mismatch/<message>/<att> what Discord serves now, when not the recorded size
<guild>/<channel>/legacy/<folder>/<file>               files no record claims (pre-2024 metadata)
<guild>/<channel>/names/<folder>                       every folder name the channel had
<guild>/snapshots/archive-<yyyy-mm-dd>.db              VACUUM INTO of archive.db
log.csv                                                appended once per archive run (`appendOnce`, conditional)
state/<path below the output root>                     the bot's working state (lib/stateSync.js)
```

- `archive.db` is a local CACHE: every batch it was built from is in the store, so it rebuilds.
- **The host holds nothing the store does not.** At start, before login, `lib/storeRestore.js` fills in
  what is missing: all state when the root has none, a guild's batches plus a rebuilt `archive.db` when
  its channel folders have no db (or the host is fresh), and the import manifest from the store's
  listing. Attachments stay in the store. It asks the store only when something is missing, so a whole
  host starts with the endpoint down; a host missing something it cannot fetch exits and PM2 retries.
- `lib/archiveImport.js` copies local files up, 30 s after start, every 10 min while the key is
  unbound, then daily, and within 2 min of every archive run (`requestSoon`). Every PUT sends its sha256 (the store refuses a mismatch), so `uploaded`/`same`
  in `Output/import/manifest.jsonl` is a store-verified byte match. A key holding other bytes is a
  `conflict`, never overwritten. **It never deletes local files.**
- `lib/stateSync.js` keeps `state/…` current every 10 min: scheduled/sentMessages/spaces/cardtable JSON,
  the tasklist, and any other non-archive file under the root. The local file stays the working copy and
  a running bot never reads state back from the store, so reminders fire with the endpoint down. Writes are
  compare-and-swap against the version this process last wrote; another writer is logged as a conflict.
  A SIGTERM runs one last pass (capped at 1 s, inside PM2's kill timeout). In central mode the pass
  runs every 15 s under the lease token and tombstones removed files (see **Central mode**).
- The binding is the operator's: Command Station → Account → Data bindings (`archivebot-service-key`).
- Attachments are `attachments/<id>_<name>` on disk. Until 2026-10-25 they were by name alone, and
  same-named files overwrote each other; `/archiverepair` recovers what Discord still has.
  From the host, `kill -USR2 <bot pid>` (the `node …/index.js` child of the PM2 wrapper) applies it to
  every archived guild inside the running bot; progress is `repairChannel`/`repairGuild` in its log.
  An attachment the import manifest shows the store holding counts as `stored`, not missing, so a
  repair after `scripts/prune-imported.js --apply` downloads nothing again.
- `tests/dataStore.test.js`, `tests/archiveImport*.test.js`, `tests/central*.test.js` and the state
  tests run dataplatform's REAL listener on a scratch store (`tests/support/`), so they need
  `~/srv/hadoku-dataplatform/server/.venv` (`DATAPLATFORM_SERVER` overrides). Without it they fail;
  they do not skip.

## Central mode (hot standby)

`ARCHIVEBOT_STATE_STORE=central` meets the fleet's off-node contract
(`hadoku-fleet-manager/docs/service-state.md`): the store is the truth, the disk a working copy,
and a second copy of the bot on another node waits as a standby. `hosting.json` gets
`fence: "data-lease"`, `standby: 1` and `label:data-peer` only AT the cutover, after the
rehearsal and once the wrapper sets the switch: declared earlier, the fleet would place a second
copy beside a bot that holds no lease, and both would post to Discord. Unset, the bot runs on-node exactly as
above. `HADOKU_DATA_URL` alone is not the switch, because the on-node bot already uses it for the
import: flipping on it would turn the lease on with a deploy instead of a cutover.

```
standby ──lease──▶ reconciling ──store == disk──▶ starting ──Discord ready──▶ active
```

- **The lease** is `state/` in namespace `archivebot`, TTL 30 s, renewed every 10 s
  (`lib/heldLease.js`), holder = the node's hostname. It is taken BEFORE `client.login`: a process
  without it never logs in to Discord (two logged-in copies would post every reminder twice),
  and the scheduler, importer and state sync only start on `clientReady`.
- **Lost** = a renewal refused, a write refused as `lease_lost`, or no renewal confirmed for a
  whole TTL (its own timer, so a hung request cannot hold the verdict back). Then every writer
  stops, the Discord client is destroyed and the process exits **75**; PM2 restarts it as a
  standby. A SIGTERM instead does a last state pass and hands the lease back, so the standby
  takes over at once.
- **The fence** (`DataStore.setProcessFence`): every `DataStore.fromEnv()` in the process carries
  it. Writes under `state/` send `X-Lease-Token`; with no live lease NO write leaves the process,
  under `state/` or outside it. The archive keys (`<guild>/…`, `log.csv`) cannot carry the token:
  the endpoint refuses a lease on the namespace root and refuses a token on a key its lease does
  not cover. They are create-only and sha256-checked, so a stale writer can add nothing but a
  record it really fetched, and the in-process fence stops even that once the lease is gone.
- **`/health`**: 503 `{detail: {central: {state, holder}}}` on EVERY path until active (states
  `standby`, `reconciling`, `starting` read as waiting in hadoku_site's `leaseRole`; `refused`,
  `failed`, `lost` are faults). Active: 200 `{status: "ok", commit, discord, central: {state:
  "active", holder, committed_s_ago}}`. `committed_s_ago` counts from the last clean state pass.
- **Takeover reconcile** (`lib/reconcile.js`), before login: `storeRestore` first (a fresh host),
  then `state/` with the store winning (a local file that differs or that the store lacks moves
  to `.central/orphans/<stamp>/`, never deleted), then the archive through the change feed
  (cursor in `.central/cursor.json`; records the store gained are fetched into the channel's
  folder and ingested). **An empty `state/` beside a non-empty local state tree refuses to
  start**: that is a node pointed at the store before the on-node bot synced it.
- **Writes**: state goes up every 15 s by compare-and-swap with the token, and a file the bot
  removed becomes a tombstone (else the next takeover would bring it back). That 15 s is the
  state's loss bound. Archive batches go up within 2 min of the run that wrote them
  (`archive.onArchived` → `archiveImport.requestSoon`), and the daily sweep catches the rest;
  anything not yet imported is re-fetchable from Discord by the next archive run.
- **Cutover**: the on-node bot keeps `state/` current and, since this change, flushes it on
  SIGTERM. So: confirm `state/` is populated, set `ARCHIVEBOT_STATE_STORE=central` in the
  wrapper's env, restart. The first central start reconciles against what the old process
  flushed. Rehearse against a copy of real data first (`service-state.md`, "How to request it").

## Dev commands

```bash
npm test                  # run tests
npm run test:coverage     # tests with coverage
npm run test:watch        # watch mode
node index.js             # run locally
```

## Does NOT

- Publish an npm package or export anything for other repos (standalone PM2 service)
- Follow the hadoku-site UI/worker/tunnel contract pattern (see `.github/workflows/deploy.yml`)
- Use TypeScript or yarn (see `package.json`). It DOES use pnpm — `pnpm-lock.yaml`
  and `pnpm-workspace.yaml` are committed and the deploy installs with it.

## Auth & secrets (hadoku ecosystem)

- **Browser fetches** (if this repo serves any UI) must hit `hadoku.me/{prefix}/*` via edge-router — NEVER `*.hadoku.me` direct subdomains. The `hadoku_session` cookie (`Domain=.hadoku.me`, 30d sliding) is set on `/auth` and resolved server-side into `X-User-Key`.
- **Secrets**: vault-broker model, NO `.env` files. Production runtime secrets are injected by the PM2 wrapper at `../hadoku_site/services/pm2/<service>-wrapper.mjs` — wrapper waits for vault unlock, fetches needed keys, execs the service with them in `process.env`. To add or change a key, see `../hadoku_site/docs/operations/SECRETS.md`. For local dev, the broker pattern (`.devvault.json` + `node ../hadoku_site/scripts/secrets/dev-vault.mjs`) is documented at `../hadoku_site/docs/child-apps/USING_VAULT.md`.
- **Auth model**: 1:1 named user-keys. `/auth` accepts key + name; whoami returns the name. Admin endpoints `GET/POST/DELETE /session/admin/keys` manage the registry. See `../hadoku_site/docs/planning/next-work.md`.
