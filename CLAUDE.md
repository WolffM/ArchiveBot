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
- Permissions: `permissions.hasAdminAccess(guildId, userId)` / `permissions.hasTaskAccess(guildId, userId)`
- Time parsing: `parseRelativeTime()` / `parseDateTime()` in `lib/scheduler.js`
- Graceful shutdown: SIGTERM/SIGINT handlers in `index.js`
- Slash commands auto-register on PM2 start/restart

## External dependencies

- Discord API via discord.js
- `scraper.hadoku.me` — pickleball automation (`lib/pickleball.js`, env: `SCRAPE_API_URL`)
- Deploy: `.github/workflows/deploy.yml` → repository dispatch to `WolffM/hadoku_site`

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
- `ARCHIVEBOT_EVENT_GUILD_ID` / `ARCHIVEBOT_EVENT_CHANNEL_ID` — where webhook-created events land and announce
- `WEBHOOK_PORT` — defaults to 3004

Telemetry (see **Notifications & telemetry**):
- `MONITORING_SERVICE_KEY` — monitoring service-tier key. Unset = the ledger mirror is a no-op.
- `MONITORING_TELEMETRY_URL` — defaults to `https://hadoku.me/health/api/telemetry`

Other:
- `SCRAPE_API_URL` — defaults to `https://scraper.hadoku.me`
- `SCRAPE_SERVICE_KEY` — service key for that API
- `LOG_LEVEL` — `DEBUG|INFO|WARN|ERROR`, defaults to `INFO`

GitHub secret: `HADOKU_SITE_TOKEN` (deploy workflow)

## Notifications & telemetry

Two conventions, both ecosystem-wide. Follow them when adding a send site.

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
