# CLAUDE.md - AI Assistant Guidelines for ArchiveBot

## Project Overview

ArchiveBot is a Discord bot built with discord.js v14 that provides:
- **Message archiving** - Export channel/server messages to CSV, JSON, and SQLite
- **Task management** - Guild-based task tracking with assignments and categories
- **Color roles** - Let users pick display colors from available guild roles
- **Permission system** - Admin/task access control per guild
- **Reminders** - Scheduled @everyone reminders with recurring support
- **Events** - Create Discord Scheduled Events via slash command

## Tech Stack

- **Runtime:** Node.js
- **Framework:** discord.js v14.16.3
- **Database:** SQLite (for archives)
- **Storage:** JSON files (for tasks, permissions, colors)

## Project Structure

```
ArchiveBot/
├── index.js              # Entry point, bot init, command routing
├── commands.js           # Slash command definitions and handlers
├── lib/                  # Feature modules
│   ├── archive.js        # Message archiving to CSV/JSON/SQLite
│   ├── tasklist.js       # Task CRUD operations
│   ├── colorroles.js     # Color role management
│   ├── permissions.js    # Permission system
│   └── scheduler.js      # Reminders and Discord Scheduled Events
├── utils/                # Shared utilities
│   ├── helper.js         # Utility functions (file I/O, logging)
│   └── users.js          # User data for task system
├── tests/                # Unit tests
│   ├── mocks/            # Test mocks for Discord.js and filesystem
│   └── *.test.js         # Test files
├── Output/               # Generated archives and task data (gitignored)
└── Resources/            # Guild configs like permissions (gitignored)
```

## Key Patterns

### Command Structure
Commands are defined in `commands.js` with this pattern:
```javascript
{
  description: 'Command description',
  options: [
    { name: 'param', description: 'desc', type: 3, required: true }
  ],
  execute: async (interaction) => { ... }
}
```

Option types: 3=STRING, 4=INTEGER, 5=BOOLEAN, 6=USER, 7=CHANNEL, 11=ATTACHMENT

For CHANNEL type, use `channel_types: [2, 13]` to filter to voice/stage channels.

### Guild Data Storage
Each guild's data is stored in separate directories:
- `Resources/{guildId}/` - Config (permissions, color roles)
- `Output/{guildId}/` - Generated data (archives, scheduled items)
- `Output/tasklist/{guildId}/` - Task system data

### Permission Checks
Admin commands check `permissions.hasAdminAccess(guildId, userId)`
Task commands check `permissions.hasTaskAccess(guildId, userId)`

### Time Parsing (scheduler.js)
The scheduler supports flexible time formats:
- Relative: `2h`, `30m`, `1d`, `2w`, `1h30m`
- 24-hour: `10:00`, `4:00`, `16:30`
- 12-hour: `4am`, `4pm`, `4:30am`, `10:30pm`
- With date: `2026-01-20 10:00`, `2026-01-20 4pm`
- Tomorrow: `tomorrow 10:00`, `tomorrow 4pm`

Use `parseRelativeTime()` or `parseDateTime()` from scheduler.js.

## Known Issues to Be Aware Of

### Critical
1. **Permission path inconsistency** - `loadPermissions()` uses `Resources/` but `setPermission()` uses `Output/permissions/`. This causes permission checks to fail.

2. **Property name mismatch in permissions.js** - Code uses both `adminUsers`/`admins` and `taskUsers`/`taskAccess` inconsistently.

### Important
3. **No error handling** on many file operations
4. **Memory issues** - Archives load all messages into memory
5. **CSV parsing is fragile** - Doesn't handle escaped commas properly
6. **Task IDs** - Simple incrementing integers, no collision protection

## Development Commands

```bash
# Install dependencies
npm install

# Run the bot locally
node index.js

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Deployment

The bot is managed via PM2 on the hadoku.me server.

### Automatic Deployment
Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`) which:
1. Calls `POST https://hadoku.me/mgmt/api/archive-bot/redeploy`
2. The mgmt-api pulls latest code and restarts the PM2 process

### Manual Deployment
```bash
# Via hadoku_site
pnpm local:restart archive-bot

# Or via API
curl -X POST https://hadoku.me/mgmt/api/archive-bot/redeploy -H "X-API-Key: <key>"
```

### Monitoring
```bash
# Check status
pm2 status archive-bot

# View logs
pm2 logs archive-bot

# Via API
curl https://hadoku.me/mgmt/api/archive-bot/logs -H "X-API-Key: <key>"
```

### Graceful Shutdown
The bot handles SIGTERM/SIGINT signals for clean PM2 restarts - see `index.js` shutdown handler.

### Command Registration
Slash commands are automatically re-registered on PM2 start/restart. No manual registration needed.

## Environment Variables

Required in `.env` (local) or hadoku_site `.env` (production):
```
DISCORD_TOKEN=<bot_token>
CLIENT_ID=<application_id>
```

### GitHub Secrets Required
- `MGMT_SERVICE_KEY` - API key for hadoku.me mgmt-api

## When Making Changes

1. **Test locally** with a test Discord server
2. **Check permission paths** - Ensure consistency between Resources/ and Output/
3. **Handle errors** - Many functions silently fail
4. **Consider memory** - Large guilds may have millions of messages
5. **Preserve backward compatibility** - Existing task/permission JSON files need to work

## File Dependencies

```
index.js
├── commands.js (command definitions)
└── lib/permissions.js (permission checks)

commands.js
├── lib/archive.js (archiving functions)
├── lib/tasklist.js (task functions)
├── lib/colorroles.js (color functions)
├── lib/permissions.js (permission checks)
└── lib/scheduler.js (reminders and events)

lib/tasklist.js
├── utils/helper.js
├── utils/users.js
└── lib/permissions.js

lib/archive.js
└── utils/helper.js

lib/colorroles.js
└── utils/helper.js

lib/permissions.js
└── utils/helper.js
```
