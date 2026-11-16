# ArchiveBot: history

ArchiveBot started as a single Discord bot file and grew, in stages, into a
database-backed archive with its own repair tooling and a server-layout
command for a companion app.

## A plain start (December 2024)

The repo's first commit, on 2024-12-04, added a `.gitignore` and a one-line
README — no code yet (`9dfb8d9`); the real bot code followed afterward.

## Growing a test suite, then a shape to put it in (January 2026)

Jest testing landed first, with 114 passing tests against the bot's
existing single-file layout (`2a0b03a`, 2026-01-15). Two days later the
feature modules were split out of that single file into `lib/` and the
shared helpers into `utils/`, with every import path and the coverage
config updated to match (`532c14e`, 2026-01-17).

## Making the archive survive bad data (March 2026)

The biggest single commit in the repo's history landed on 2026-03-14: a fix
for two separate crashes in message archiving — a `discord.js` `Poll`
constructor throwing on expired or null poll data, and a null channel
reference on archived forum threads — adding 11,786 lines and removing
11,737 across 36 files, most of it line-ending normalization alongside the
real fix (`6a76419`).

## Off npm (July 2026)

The project moved from npm to pnpm, replacing `package-lock.json` with
`pnpm-lock.yaml` and adding a seven-day cooldown before any newly published
outside package can be installed, so a malicious release has time to be
caught before this bot ever pulls it; the full jest suite — 227 tests — was
verified passing on two different Node versions as part of the same change
(`f9a8ed5`, 2026-07-13).

## hadoku-cardtable's own layout (October 2026)

Two features landed two days apart. First, a signed-webhook integration let
[hadoku-cardtable](https://github.com/WolffM/hadoku-cardtable) send Discord
messages and create scheduled events through routes authenticated with its
own HMAC secret, plus a `/setup layout:cardtable` command that converges a
server onto that app's expected channel and role layout, rolling back
anything it created if the run fails (`3f7b300`, 2026-10-23). Two days later, a fix
changed how attachments are saved on disk, from the file's name alone to
its Discord attachment id plus name — closing the gap that let two
same-named uploads in one channel silently overwrite each other — and a new
`/archiverepair` command was built specifically to find and recover what
that overwriting had cost, where Discord still had it (`3520dcf`,
2026-10-25).

## Standing in for itself (November 2026)

A hot-standby mode let a second copy of the bot, on another machine, hold a
renewable lease and take over automatically if the first copy's host goes
down — the lease is taken before the bot ever logs into Discord, so two
logged-in copies posting the same reminder twice isn't possible even during
a handover (`af8b02e`, 2026-11-03).

## Trivia

Between 2025-04-07 and 2025-09-27 — a gap of 173 days, the longest quiet
spell in the repo's history — nothing was committed at all; the commit on
each end of that gap carries a one-line message, `fixed broken tasks` and
`color updates` respectively (`5970789`, `5480ebd`).
