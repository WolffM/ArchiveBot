---
title: ArchiveBot
summary: >-
  A Discord bot for one server's archive, task list and reminders: it saves
  every message and attachment in a channel to a local, searchable database,
  tracks a shared task list, posts timed reminders and real Discord
  scheduled events, and lets anyone pick their own name colour. Admin access
  is a per-server Discord permission the bot checks itself, not a hadoku.me
  tier.
features:
  - name: Channel and server archiving
    summary: 'Saves every message and attachment in a channel (or a whole server) to a local database.'
    anchor: channel-and-server-archiving
  - name: Attachment repair
    summary: 'Finds attachments an old naming bug lost to overwrites and re-downloads what Discord still has.'
    anchor: attachment-repair
  - name: Task lists
    summary: 'A shared, taggable task list per server: add, take, tag, complete and review history.'
    anchor: task-lists
  - name: Reminders and events
    summary: 'One-off and recurring reminders, and real Discord scheduled events kept in sync with them.'
    anchor: reminders-and-events
  - name: Name colour
    summary: 'Pick your own display colour by name, role, or hex code — open to anyone.'
    anchor: name-colour
  - name: Server layout setup
    summary: "`/setup layout:cardtable` converges a server onto hadoku-cardtable's channel and role layout."
    anchor: server-layout-setup
trivia:
  - 'The first commit, on 2024-12-04, added a `.gitignore` and a one-line README — no code yet (`9dfb8d9`).'
  - 'A single fix for two null-reference crashes in message archiving added 11,786 lines and removed 11,737 across 36 files, the biggest commit in the repo (`6a76419`).'
  - 'A naming bug meant every later same-named attachment in a channel silently overwrote the one before it; a repair command was built to find and recover what Discord still had (`3520dcf`).'
  - 'The bot can run as a hot standby of itself: a second copy on another machine holds a lease and only logs into Discord once it wins that lease, so a crashed host hands off without ever running two logged-in copies at once (`af8b02e`).'
---

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
