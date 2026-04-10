# CLAUDE.md - ArchiveBot

## What this is

Discord bot (discord.js v14, Node.js, SQLite). Features: message archiving, task management, color roles, permissions, reminders/events, pickleball automation.

PM2 service on hadoku.me. Deployed via push to `main` → GitHub Actions → repository dispatch to `WolffM/hadoku_site` → PM2 restart.

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
- `hadoku.me/scraper` — pickleball automation (`lib/pickleball.js`, env: `SCRAPE_API_URL`)
- Deploy: `.github/workflows/deploy.yml` → repository dispatch to `WolffM/hadoku_site`

## Environment variables

Required in `.env`:
- `DISCORD_TOKEN` — bot token
- `CLIENT_ID` — application ID

Optional:
- `SCRAPE_API_URL` — defaults to `https://hadoku.me/scraper`

GitHub secret: `HADOKU_SITE_TOKEN` (deploy workflow)

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
- Use TypeScript, pnpm, or yarn (see `package.json`)
