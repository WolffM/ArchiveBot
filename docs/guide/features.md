# ArchiveBot: features

What each part does and how to use it. How it is built is in
[contributing.md](contributing.md).

Every command below needs the server's own admin access unless its section
says otherwise. You're the server owner, you hold a role literally named
`admin`, or an admin granted you access with `/assign`
(`permissions.hasAdminAccess`). This is a per-server Discord permission the
bot checks itself, not a hadoku.me tier.

## Channel and server archiving

**What it does.** Pulls a channel's full message history, and optionally its
attachments, into a local store (`lib/archive.js`). `/archivechannel`
archives the current channel; `/archiveserver` loops it over every channel
in the server. Both take `attachments` and `messages` toggles so you can
archive either half on its own. Each attachment is saved under its Discord
attachment id as well as its filename, so two different files that happen
to share a name never collide.

**How to use it.** Run `/archivechannel` in the channel you want archived, or
`/archiveserver` anywhere in the server to archive every channel.

**Weekly, without asking.** Every server the bot is in is archived once a
week (`lib/archiveSweep.js`), and a server it joins is archived the moment it
arrives. Nothing is posted about it unless the server already had a status
channel; otherwise the run is only written to the bot's log.

**What it does not do.** It does not archive voice, and threads are not called
out separately from their parent channel.

## Attachment repair

**What it does.** `/archiverepair` looks at what a past filename-only save
left broken, channel by channel. Each attachment falls into one of four
buckets:

- already correctly named by attachment id;
- safe to rename from its old by-name copy;
- lost to a same-named sibling that overwrote it, so it must be re-fetched
  from Discord; or
- a pre-existing file no archive record claims at all, left alone as legacy.

It's a dry run by default; `apply:true` renames and re-downloads. It replies
at once and sends the result by DM once it finishes — a large server's
repair can take an hour or more. A repair can also be triggered on the host
itself (`kill -USR2` on the bot process) to run it across every archived
server in one pass.

**How to use it.** `/archiverepair` to see the plan; `/archiverepair
apply:true` to act on it.

**What it does not do.** It cannot recover a file Discord itself no longer
serves — a 404 during recovery counts the attachment as gone, not repaired.
Legacy files (older than the attachment-id records) are reported, never
renamed or deleted.

## Task lists

**What it does.** A shared task list per server (`lib/tasklist.js`). `/task`
adds one, `/take` claims one or more by number, and `/done` completes
them — or creates and completes a task in one step. `/tag` applies a
category, `/delete` removes one, and `/history` shows what has been
completed. `/init` sets the list up the first time it is used in a server.

**How to use it.** `/task description:"restock snacks"`, then `/take
name:1`, then `/done name:1` when it's finished.

**What it does not do.** There is no due date or recurring task here; that is
what [Reminders and events](#reminders-and-events) are for. A task is just a
description, a status and whoever is assigned.

The permissions system also stores a narrower "task" grant (`/assign
type:Task`), meant to let someone use the task list without full admin
access. That grant does not currently work: every task command is dispatched
through the same admin-only check as archiving and reminders, so a task-only
holder cannot run `/task`, `/done`, `/take`, `/tag`, `/delete` or `/history`.
See [contributing.md](contributing.md#architecture) for where that check
lives.

## Reminders and events

**What it does.** `/reminder` posts a message at a relative or absolute
time (`"2h"`, `"30m"`, `"2026-01-20 10:00"`), optionally repeating on a
plain interval (`1d`, `1w`, `2w`, `1m`, `1y`). `/event` creates a real
Discord scheduled event (voice, stage, or external/outside Discord) with
its own optional reminder before it starts, and keeps a Discord-side edit to
that event's time in sync with what the bot scheduled. `/show` lists what's
upcoming; `/remove` cancels a reminder or event by id (`lib/scheduler.js`).

**How to use it.** `/reminder at:"2026-01-20 10:00" message:"stand-up"
recurring:1w` for a weekly reminder; `/event name:"Game night"
start:"2026-01-20 19:00" type:voice channel:#table`. `/show` to see
everything scheduled; `/remove id:5`.

**What it does not do.** A reminder is a plain text post, not a scheduled
event — only `/event` creates something Discord's own event UI shows and
lets members RSVP to. A reminder or event missed while the bot itself was
offline does not fire late when it comes back; it is dropped.

## Name colour

**What it does.** `/color` sets your own display colour, by a common colour
name, an existing role's id, or a hex code (`#FF0000`); `/colorshow` lists
the colours available and how to specify a custom one
(`lib/colorroles.js`). Each server keeps its own set of colour roles,
created on first use. **This command needs no admin or task access** — it
is open to anyone in the server (`commandCategories.color`).

**How to use it.** `/color color:Red`, or `/color color:#FF0000` for an
exact shade. `/colorshow` to see the options first.

**What it does not do.** It changes only your own colour; there is no way
to set another member's colour through this command, and the colour role
carries no permissions of its own.

## Server layout setup

**What it does.** `/setup layout:cardtable` converges the current server onto
[hadoku-cardtable](https://github.com/WolffM/hadoku-cardtable)'s expected
Discord layout: read-only info channels, a general/looking-for-game/bugs set,
voice tables, an admin-only #bot-alerts under Staff, an Admin and a Linked
role, and a permanent invite. It also
binds that server so cardtable's own signed webhook calls land in the right
channels (`lib/cardtableSetup.js`). It is safe to re-run: existing pieces are
found and adopted rather than duplicated, and a failed run undoes whatever it
created rather than leaving a half-built layout. Anyone who has linked their
Discord account to a hadoku.me account gets a **Linked** role automatically,
and that account's display name as their server nickname, kept current as
they rename themselves (`lib/cardtableMembers.js`).

**How to use it.** `/setup layout:cardtable`, once the bot has been invited
with the permissions it asks for (missing ones are named back to you, with a
one-click link that grants them, rather than causing a half-built layout).
Safe to run again any time to repair a channel or permission someone changed
by hand.

## Honeypot and verify

**What it does.** Two ways to keep spam accounts out of a server
(`lib/gate.js`). A **honeypot** channel: anyone who posts in it is kicked at
once and their post deleted, and the operator gets an emergency notice naming
the member, when their account was made and when they joined, the invite they
joined through, and who created that invite. Spam accounts post in every
channel they can see; people read the channel's name. A **verify** message:
the bot posts it, and anyone who reacts to it gets the role you chose, so the
rest of the server can stay hidden until they do.

**How to use it.** Run the command in the channel itself; it binds by channel
id, so renaming the channel later changes nothing.

- `/gate mode:honeypot` makes this channel the honeypot.
- `/gate mode:verify role:@member` posts the verify message here. `text:`
  replaces its wording, with `{role}` standing for the role's name.
- `/gate mode:off` unbinds whatever is in this channel; `/gate mode:status`
  shows both.

**What it does not do.** Admins are never kicked: their post in the honeypot
is reported as a test. The invite is only known for people who joined after
the honeypot was set up, and not at all for two joins in the same instant or
a join through the server's vanity URL; the notice then says "unknown" and
why. Taking the reaction off does not take the role away. The role must sit
below the bot's own role, which `/gate` checks before posting.

## Alerts

**What it does.** When the bot could not do something it owed somebody (an
event not created, a reminder that could not fire, a message not delivered),
or when its server permissions fall short of what its features need, it says
so in the server's **#bot-alerts**: what failed, which caller asked, the
Discord error, and the fix. A missing permission comes with a re-authorise
link that adds every permission the bot needs to its own role in one click
(`lib/botAlerts.js`, `lib/botPermissions.js`).

**How to use it.** Nothing to run: `/setup layout:cardtable` creates
#bot-alerts, visible only to Admin and the bot, and any server can opt in by
making a text channel of that name. Without one, the server owner gets a DM.

**What it does not do.** It cannot grant itself permissions: Discord does not
let a bot raise its own role, so the link is the fix, clicked by the owner.
It sends the same alert at most once an hour. In a server with no
#bot-alerts that is not the cardtable server, a permission shortfall is only
logged, not messaged.

**What it does not do.** It only knows the one layout; it does not delete
anything outside that layout; and it refuses to bind a second server once
one is already bound.

## Trivia

A server set up for cardtable before the **Linked** role existed never needs
`/setup` run again just to get it. The first person it applies to finds a
role named Linked, or creates one with no special permissions of its own;
nothing else in the layout is touched (`1fd51a6`).
