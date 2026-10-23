# Request to ArchiveBot: cardtable's Discord server

**From:** hadoku-cardtable, 2026-10-23
**Plan:** `hadoku-cardtable/docs/planning/discord-integration.md`

cardtable (the friend-group Magic draft and play app at `hadoku.me/cardtable`) is getting its own
Discord server. The operator wants ArchiveBot to run its automation: *"posting patch notes and
creating tournament events, that stuff i'm hoping can be handled by archivebot."*

A survey of this repo (2026-10-23) found that most of it already exists. `/api/messages/send` and
`/api/events/create|update` do the Discord side. These asks are what's missing, in priority order.
Each one follows the patterns already here: HMAC plus timestamp plus idempotencyKey, a separate
secret per capability, one `lib/` module per capability, Jest tests against `tests/mocks/discord.js`,
and `log.fail` (not ledger alerts) for refused requests.

## Ask 1: a cardtable secret for messages and events

Today the only way in is `ARCHIVEBOT_EVENTS_WEBHOOK_SECRET`, which meet-api holds. cardtable should
not share meet's key. Please add `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`, accepted on
`/api/messages/send`, `/api/events/create`, `/api/events/update` and `/api/events/channels`, as the
spaces routes do for theirs (`lib/webhookServer.js:203-206`). It could be a second accepted secret on
those routes, or a `/api/cardtable/*` alias group; ArchiveBot decides.

`/api/events/channels` must list the guild in the request (`guild_id`), or a configured cardtable
guild, not only the env default. Otherwise cardtable can't discover its own channels.

The hadoku_site half: add the vault key to `services/pm2/archive-bot-wrapper.mjs` `vaultKeys` and
`services/pm2/cardtable-wrapper.mjs`, and document it in `docs/operations/SHARED_SECRETS.md`.

## Ask 2: embeds on `/api/messages/send`, behind that secret

Patch notes don't fit 2000 chars of plain text. Please accept an optional `embeds` array, validated
to a small subset: `title`, `description` (≤4096), `url`, `color`, `fields[]` (name/value/inline,
≤25), `footer.text` and `timestamp`. Reject images, author icons, and anything else. Mentions stay
off. The 7-day idempotency dedupe applies unchanged; cardtable will key on
`cardtable-release-<version>`.

## Ask 3: guild bootstrap (ensure-channel, ensure-role, invite)

A new module modeled on `lib/meetingSpace.js`, with idempotency, rollback on partial failure, and
ledger mirroring:

- `POST /api/guild/ensure-channel`: `{ guild_id, name, type: text|voice|announcement, category?,
  readOnly? }`. Creates the channel or returns the existing one with that name. `readOnly` denies
  `@everyone` Send Messages and allows the bot.
- `POST /api/guild/ensure-role`: `{ guild_id, name, color? }`.
- `POST /api/guild/invite`: `{ guild_id, channel_id, maxAge: 0, maxUses: 0, roleOnJoin? }`. Returns
  the invite URL. It reuses the existing invite→role binding (`index.js:212`).

Its own secret (`ARCHIVEBOT_GUILD_WEBHOOK_SECRET`), not the messages one. An admin slash command
that runs the same code is fine instead, if you prefer: cardtable needs this once, not on every
deploy. The operator creates the guild by hand and invites the bot; this covers everything after that.

## Ask 4 (later, not blocking): Discord ↔ hadoku identity link

For tournament sign-ups and "your match is ready" pings: a `/link <code>` slash command. cardtable
mints a short-lived code for the signed-in hadoku user, and the bot stores `discordUserId ↔ hadokuUserId`
per guild (a JSON store like `meetingSpaceStore.js`), behind a signed lookup route. Design it when
Asks 1–3 have landed; this is here so the store shape doesn't paint it out.

## Not asked

- Voice/stage events, recurrence and cover images over the webhook. External events are enough for
  tournaments.
- Role pings. If cardtable ever wants one, that will be a separate request.

## Done when

- Asks 1–3 are deployed, the secrets are in the vault, and the routes are documented in AGENTS.md.
- Reply in `hadoku-cardtable/docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md` with route
  shapes and secret names.
