# ArchiveBot

ArchiveBot is a Discord bot that runs as a small, always-on service for one
server (or a handful of them). Its core job is archiving: saving every
message and attachment a channel has ever had into a local, queryable
database, so nothing is lost to Discord's own retention or a channel getting
deleted. Around that it carries a shared task list, a reminder and
Discord-event scheduler, and a one-command colour picker for your display
name. For one server it also converges a Discord layout onto a companion
app's own, keeping linked members' roles and nicknames current.

Most of what it does needs the server's own admin access (its owner, or
whoever holds a role literally named `admin`); picking a colour needs none.

A command and its reply (`/color`, `lib/colorroles.js:392`):

```text
/color color:Red
→ Your color has been set to Red!
```

- [Features](features.md): what each command does and how to use it.
- [Contributing](contributing.md): running it locally, the architecture, how it deploys.
- [History](history.md): from a single-file bot to a database-backed archive and a server-layout tool.
- [Trivia](trivia.md)

## Trivia

A single commit fixing two message-archiving crashes added 11,786 lines and
removed 11,737 across 36 files — the biggest single commit in the repo's
history
([history](history.md#making-the-archive-survive-bad-data-march-2026)).
