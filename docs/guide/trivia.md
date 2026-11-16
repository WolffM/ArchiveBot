# ArchiveBot: trivia

The best facts about ArchiveBot, each with its source.

## Trivia

- **A quiet beginning.** The repo's very first commit, on 2024-12-04, added
  only a `.gitignore` and a one-line README — no code yet (`9dfb8d9`).
- **The biggest commit fixed two null checks.** The largest single commit in
  the repo's history — 11,786 lines added and 11,737 removed across 36
  files — was a fix for a
  `discord.js` `Poll` constructor crashing on expired data and a null
  channel reference on archived forum threads; most of the line count was
  CRLF-to-LF normalization riding along with the real fix (`6a76419`).
- **A naming bug that cost thousands of files.** Attachments were once saved
  to disk by filename alone, so a second `image.png` in the same channel
  silently overwrote the first; the fix moved every attachment to its
  Discord id plus name, and a dedicated repair command was built to recover
  what the collision had cost, where Discord still served it (`3520dcf`).
- **173 days of silence.** The longest gap with no commits at all in the
  repo's history ran from 2025-04-07 to 2025-09-27 — the commit on each end
  carries a one-line message, `fixed broken tasks` and `color updates`
  (`5970789`, `5480ebd`).
- **The bot can stand in for itself.** A hot-standby mode lets a second copy
  of the bot, on another machine, hold a renewable lease and take over if
  the first copy's host goes down — the lease is taken before the bot logs
  into Discord at all, so a handover can never leave two copies logged in
  and posting the same reminder twice (`af8b02e`).
