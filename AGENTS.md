# CLAUDE.md - ArchiveBot

## What this is

Discord bot (discord.js v14, Node.js, SQLite). Features: message archiving, task management, color roles, permissions, reminders/events, pickleball automation.

Local PM2 service (runs on the developer's Windows/WSL machine, not a remote server). Deployed via push to `main` → GitHub Actions `repository_dispatch` to `WolffM/hadoku_site` → self-hosted runner on the same machine → `git pull` + `pnpm install --frozen-lockfile` + `pm2 restart archive-bot`. The build command lives in `../hadoku_site/services/mgmt-api/deploy-config.json`, not here — a new dependency needs its lockfile change committed or the deploy fails on the frozen lockfile. The `hadoku.me` domain is a Cloudflare tunnel back to localhost.

## Command definitions

Slash commands defined in `commands.js`, routed from `index.js`.

Option types: 3=STRING, 4=INTEGER, 5=BOOLEAN, 6=USER, 7=CHANNEL, 11=ATTACHMENT

For CHANNEL type, use `channel_types: [2, 13]` to filter to voice/stage channels.

## Key patterns

- Guild config: `Resources/{guildId}/` — permissions, color roles
- Guild output: `Output/{guildId}/` — archives, scheduled items
- Task data: `Output/tasklist/{guildId}/`
- `Output/` is the default root; every output path goes through `lib/paths.js` (`outputPath()`), never a literal `'Output'`
- Permissions: `permissions.hasAdminAccess(guildId, userId)` / `permissions.hasTaskAccess(guildId, userId)`
- Time parsing: `parseRelativeTime()` / `parseDateTime()` in `lib/scheduler.js`
- Graceful shutdown: SIGTERM/SIGINT handlers in `index.js`
- Slash commands auto-register on PM2 start/restart

## External dependencies

- Discord API via discord.js
- `scraper.hadoku.me` — pickleball automation (`lib/pickleball.js`, env: `SCRAPE_API_URL`)
- Deploy: `.github/workflows/deploy.yml` → repository dispatch to `WolffM/hadoku_site`
- dataplatform's fleet data endpoint (`HADOKU_DATA_URL`), namespace `archivebot` — the archive's
  system of record. See **Archive storage**.

## Environment variables

In production these are injected by the PM2 wrapper from the vault — see **Auth
& secrets** below. `.env` (via `dotenv`) is a local-dev convenience only; the
wrapper's `vaultKeys` map in `../hadoku_site/services/pm2/archive-bot-wrapper.mjs`
is the authoritative list.

Core:
- `DISCORD_TOKEN` — bot token
- `CLIENT_ID` — application ID

Webhook server. The server starts if ANY route is fully configured; a route
whose config is missing answers 404 rather than taking the others down. With
none configured it does not start at all.
- `PICKLEBALL_WEBHOOK_SECRET` / `PICKLEBALL_CHANNEL_ID` — scraper waitlist callbacks
- `ARCHIVEBOT_EVENTS_WEBHOOK_SECRET` — HMAC for `/api/events/*` and `/api/messages/send`, shared with meet-api
- `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` — cardtable's own HMAC on the same four routes; see **cardtable guild**.
  Unset = cardtable-signed requests 401; meet is unaffected.
- `ARCHIVEBOT_EVENT_GUILD_ID` / `ARCHIVEBOT_EVENT_CHANNEL_ID` — where webhook-created events land and announce
- `WEBHOOK_PORT` — defaults to 3004

Telemetry (see **Notifications & telemetry**):
- `MONITORING_SERVICE_KEY` — monitoring service-tier key. Unset = the ledger mirror is a no-op.
- `MONITORING_TELEMETRY_URL` — defaults to `https://hadoku.me/health/api/telemetry`

Other:
- `ARCHIVEBOT_OUTPUT_DIR` — root for ALL output (archives, attachments, scheduler/sent/spaces/
  cardtable state, tasklist, log.csv). Defaults to `Output/` in the checkout. When set, it
  must already exist: the bot refuses to start rather than recreate it, because a missing
  root means its disk is unmounted and the mount point is an empty dir on `/`.
- `HADOKU_DATA_URL` / `HADOKU_SERVICE_KEY` — dataplatform's data endpoint and the bot's service key
  (the same vault item as `SCRAPE_SERVICE_KEY`). Both set = the importer runs. Either unset = it doesn't.
- `SCRAPE_API_URL` — defaults to `https://scraper.hadoku.me`
- `SCRAPE_SERVICE_KEY` — service key for that API
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
Player and Admin roles, and a permanent invite whose joins get Player. Safe to re-run;
on failure it deletes what that run created. `lib/cardtableSetup.js`.

A successful run writes `Output/{guildId}/cardtable.json`, and that file IS the binding:
a request signed with `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` is pinned to that guild
(another `guild_id` → 403), messages default to #announcements and event announcements
to #events, and only that caller may send `embeds` on `/api/messages/send`
(validated subset in `lib/messageWebhook.js` `validateEmbeds`). The setup refuses to
bind a second guild. The same file reserves `links` for `/link` identity linking.

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
log.csv                                                appended by every archive run
```

- `archive.db` is a local CACHE: every batch it was built from is in the store, so it rebuilds.
- `lib/archiveImport.js` copies local files up, 30 s after start, every 10 min while the key is
  unbound, then daily. Every PUT sends its sha256 (the store refuses a mismatch), so `uploaded`/`same`
  in `Output/import/manifest.jsonl` is a store-verified byte match. A key holding other bytes is a
  `conflict`, never overwritten. **It never deletes local files.**
- The binding is the operator's: Command Station → Account → Data bindings (`archivebot-service-key`).
- Attachments are `attachments/<id>_<name>` on disk. Until 2026-10-25 they were by name alone, and
  same-named files overwrote each other; `/archiverepair` recovers what Discord still has.
  From the host, `kill -USR2 <bot pid>` (the `node …/index.js` child of the PM2 wrapper) applies it to
  every archived guild inside the running bot; progress is `repairChannel`/`repairGuild` in its log.
  An attachment the import manifest shows the store holding counts as `stored`, not missing, so a
  repair after `scripts/prune-imported.js --apply` downloads nothing again.
- `tests/dataStore.test.js` and `tests/archiveImport*.test.js` run dataplatform's REAL listener on a
  scratch store (`tests/support/`), so they need `~/srv/hadoku-dataplatform/server/.venv`
  (`DATAPLATFORM_SERVER` overrides). Without it they fail; they do not skip.

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
