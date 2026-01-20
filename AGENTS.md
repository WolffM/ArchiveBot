# AGENTS.md - ArchiveBot Feature Documentation

## Bot Overview

ArchiveBot is a multi-purpose Discord bot with four main feature sets:

1. **Archive System** - Export channel/server messages
2. **Task System** - Collaborative task management
3. **Color Roles** - User-selectable display colors
4. **Permission System** - Guild-level access control

---

## Feature: Archive System

**Purpose:** Export Discord messages for backup/analysis

### Commands
| Command | Permission | Description |
|---------|------------|-------------|
| `/archiveserver` | Admin | Archive all channels in the server |
| `/archivechannel` | Admin | Archive current channel |
| `/myrecap` | Everyone | Show personal message history |

### Output Formats
- **CSV** - Spreadsheet-compatible export
- **JSON** - Structured data with full metadata
- **SQLite** - Database for complex queries

### Data Captured
- Message content, author, timestamp
- Attachments (optional download)
- Reactions and reaction counts
- Reply/thread relationships

### Storage Location
```
Output/{guildId}/
├── archive.db          # SQLite database
├── {channelName}.csv   # CSV exports
└── {channelName}.json  # JSON exports
```

---

## Feature: Task System

**Purpose:** Track tasks and assignments within a Discord guild

### Commands
| Command | Permission | Description |
|---------|------------|-------------|
| `/init` | Admin | Initialize task system for guild |
| `/task` | Task | Create new task(s) |
| `/done` | Task | Mark task(s) complete |
| `/take` | Task | Claim ownership of task(s) |
| `/delete` | Task | Remove task(s) |
| `/tag` | Task | Add category tags to task(s) |
| `/history` | Task | View completion history |

### Task Properties
- **ID** - Auto-incrementing integer
- **Description** - Task text
- **Status** - pending/complete
- **Owner** - Assigned user
- **Tags** - Category labels
- **Created/Completed** - Timestamps

### Storage Location
```
Output/tasklist/{guildId}/
├── tasks.json    # Active and completed tasks
└── users.json    # User ID mappings
```

---

## Feature: Color Roles

**Purpose:** Let users choose their display name color

### Commands
| Command | Permission | Description |
|---------|------------|-------------|
| `/color` | Everyone | Set your display color |
| `/colorshow` | Everyone | View available colors |

### Color Selection Methods
1. **By name** - e.g., `/color red`
2. **By role ID** - e.g., `/color 123456789`
3. **By hex code** - e.g., `/color #FF5500`

### How It Works
1. Bot scans guild roles on startup
2. Identifies "color roles" (roles used primarily for color)
3. Stores available colors in `Resources/{guildId}/colorRoles.json`
4. When user picks color, bot assigns that role

---

## Feature: Permission System

**Purpose:** Control who can use admin/task commands

### Commands
| Command | Permission | Description |
|---------|------------|-------------|
| `/assign` | Admin | Grant admin or task access |
| `/permissions` | Admin | List users with permissions |

### Permission Levels
1. **Admin** - Can use all commands including archive and assign
2. **Task** - Can use task management commands
3. **Default** - Can use color and basic commands only

### Storage Location
```
Resources/{guildId}/
└── permissions.json    # Admin and task user lists
```

---

## Bot Architecture

### Startup Flow
1. Load environment variables (`.env`)
2. Initialize Discord.js client
3. Register global commands (color, test)
4. For each guild: register guild-specific commands
5. Listen for interactions

### Interaction Handling
```
User sends slash command
    ↓
index.js receives interaction
    ↓
Check permissions (admin/task/default)
    ↓
Route to commands.js handler
    ↓
Handler calls feature module (archive/task/color)
    ↓
Reply to user
```

### Intents Required
- `Guilds` - Access guild info
- `GuildMessages` - Read messages for archiving
- `MessageContent` - Access message content
- `GuildMessageReactions` - Track reactions

---

## Known Limitations

### Archive System
- Large channels may timeout or run out of memory
- Attachment downloads can be slow
- No incremental/delta archiving

### Task System
- No due dates or priorities
- Simple integer IDs (no UUIDs)
- No concurrent operation locking

### Color System
- Requires bot role to be higher than color roles
- Limited to existing guild roles

### Permission System
- Guild-owner detection may not work in all cases
- Path inconsistencies between Resources/ and Output/

---

## Configuration

### Required Environment Variables
```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
```

### Discord Developer Portal Setup
1. Create application at discord.com/developers
2. Create bot user
3. Enable required intents (Message Content Intent)
4. Generate invite URL with permissions:
   - Manage Roles
   - Send Messages
   - Read Message History
   - Use Slash Commands

---

## Deployment & Operations

### Process Management
The bot runs as a PM2 managed service on the hadoku.me server.

**Service name:** `archive-bot`

### CI/CD Pipeline
```
Push to main
    ↓
GitHub Actions (.github/workflows/deploy.yml)
    ↓
POST https://hadoku.me/mgmt/api/archive-bot/redeploy
    ↓
mgmt-api: git pull + pm2 restart
    ↓
Bot online with new code
```

### GitHub Secrets
| Secret | Purpose |
|--------|---------|
| `MGMT_SERVICE_KEY` | API key for hadoku.me mgmt-api |

### Monitoring Commands
```bash
# Check if bot is running
pm2 status archive-bot

# View live logs
pm2 logs archive-bot

# Restart manually
pm2 restart archive-bot
```

### Graceful Shutdown
The bot handles `SIGTERM` and `SIGINT` signals to:
1. Log the shutdown signal
2. Disconnect Discord client cleanly
3. Exit with appropriate code

This ensures PM2 restarts don't cause Discord API issues.
