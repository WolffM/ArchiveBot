# CLAUDE.md - AI Assistant Guidelines for ArchiveBot

## Project Overview

ArchiveBot is a Discord bot built with discord.js v14 that provides:
- **Message archiving** - Export channel/server messages to CSV, JSON, and SQLite
- **Task management** - Guild-based task tracking with assignments and categories
- **Color roles** - Let users pick display colors from available guild roles
- **Permission system** - Admin/task access control per guild

## Tech Stack

- **Runtime:** Node.js
- **Framework:** discord.js v14.16.3
- **Database:** SQLite (for archives)
- **Storage:** JSON files (for tasks, permissions, colors)

## Project Structure

```
ArchiveBot/
├── index.js          # Entry point, bot init, command routing
├── commands.js       # Slash command definitions and handlers
├── archive.js        # Message archiving to CSV/JSON/SQLite
├── tasklist.js       # Task CRUD operations
├── colorroles.js     # Color role management
├── permissions.js    # Permission system
├── helper.js         # Utility functions (file I/O, logging)
├── users.js          # User data for task system
├── Output/           # Generated archives and task data (gitignored)
└── Resources/        # Guild configs like permissions (gitignored)
```

## Key Patterns

### Command Structure
Commands are defined in `commands.js` with this pattern:
```javascript
{
  data: new SlashCommandBuilder().setName('commandname')...,
  async execute(interaction) { ... }
}
```

### Guild Data Storage
Each guild's data is stored in separate directories:
- `Resources/{guildId}/` - Config (permissions, color roles)
- `Output/{guildId}/` - Generated data (archives)
- `Output/tasklist/{guildId}/` - Task system data

### Permission Checks
Admin commands check `permissions.hasAdminAccess(guildId, userId)`
Task commands check `permissions.hasTaskAccess(guildId, userId)`

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

# Run the bot
node index.js
```

## Environment Variables

Required in `.env`:
```
DISCORD_TOKEN=<bot_token>
CLIENT_ID=<application_id>
```

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
├── archive.js (archiving functions)
├── tasklist.js (task functions)
├── colorroles.js (color functions)
├── permissions.js (permission checks)
└── helper.js (utilities)

tasklist.js
├── helper.js
└── users.js

archive.js
└── helper.js

colorroles.js
└── helper.js

permissions.js
└── helper.js
```
