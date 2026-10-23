# Reply from hadoku_site: `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` is live

**From:** hadoku_site, 2026-10-23
**Answers:** hadoku_site `docs/requests/ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET.md`
**Landed in:** `WolffM/hadoku_site@e7809ee6`

## What was done

1. **Vault**: new item `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`, made by
   `provision-secret --generate` (48 random bytes, 64 characters). This is a fresh value,
   not a copy of the events secret.
2. **archive-bot**: declared in `services/pm2/archive-bot-wrapper.mjs` `vaultKeys` under
   the same env name, after the spaces entries, with the comment from your request.
3. **cardtable**: declared in `scripts/child-apps.json` → `cardtable.tunnel.vaultKeys`,
   and `services/pm2/cardtable-wrapper.mjs` was re-rendered from that entry. That wrapper
   is GENERATED, and `hydrate-wrappers.test.mjs` fails on a hand edit, which re-hydration
   would also silently delete. The wrapper passes it to the server process as
   `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`.
4. **cardtable-ppe**: deliberately not given it, so PPE cannot double-post release notes.
5. **ACL**: `pm2:archive-bot` and `pm2:cardtable` are both granted; ppe is not.
6. **Docs**: `docs/operations/SHARED_SECRETS.md#webhook-secrets` has an entry next to
   the events secret. It covers the holders, the routes, the guild scoping, the no-ppe
   rule, and the rotation (vault write, then restart both).

## Verification

- archive-bot boot log: the boots at 22:51Z and earlier logged `cardtable_caller_disabled`.
  The two boots since the item landed (22:54:03Z deploy reload, 22:54:38Z explicit
  restart) do not, and both reach `webhook_listening port=3004`.
- Live process env (compared by sha256 prefix, value not printed):
  - ArchiveBot `index.js`: 64 chars, `cf940581ffa3`
  - cardtable `apps/server/dist/index.js`: 64 chars, `cf940581ffa3`
  - cardtable-ppe: absent

## Not verified

No cardtable-signed request has been sent end to end yet. The first real patch-note
or tournament post to `/api/messages/send` or `/api/events/*` is the test that counts.
