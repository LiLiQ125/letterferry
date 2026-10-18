# Weixin inbound verification status

Status: **WEIXIN_INBOUND_UNVERIFIED**

Last updated: 2026-10-18

## What is verified

- ChatGPT Web bridge smoke passed with exact `SUCCEEDED + RIVEN_WEB_SMOKE_OK`.
- Weixin credentials exist and one exact DM peer is paired.
- The current implementation carries the documented iLink auth headers, `base_info.channel_version`, `bot_agent`, QR-returned `baseurl`, and `notifyStart` / `notifyStop`.
- Persistent inbound/outbound flags remain disabled.
- Local suite passes and `npm run check` passes.

## Why inbound is still unverified

Earlier live attempts did **not** establish a fully controlled inbound proof:

1. The one-shot flow displayed the challenge before `notifyStart` and before the long-poll was known to be in flight. The user could therefore send the new challenge before the listener started.
2. The diagnostic client used a 35-second client deadline, close to the server long-poll duration. A client-side timeout could be mistaken for an empty server response.
3. Local cursor non-commit was previously described too strongly. LetterFerry can guarantee that it did not modify its own persisted cursor, but it cannot guarantee that an iLink read had no server-side consumption/replay effect.

Because of those gaps, the current failure must not be labeled proven account risk-control or proven upstream outage.

## Fixes now present

- One-shot approval now arms the listener **before** the challenge is shown.
- The terminal prints `WEIXIN_LISTENER_ARMED` only after the getUpdates request has actually started.
- The fresh challenge must be sent after that marker.
- Diagnostic polling now separates:
  - `server_messages`
  - `server_empty`
  - `client_timeout`
  - `error`
- Diagnostic output records elapsed milliseconds, HTTP status, ret/errcode, errmsg category, and cursor presence/change without printing raw cursor/token/content.
- The diagnostic timeout is 45 seconds.
- Paired-DM messages observed by one-shot are durably staged before later cursor handling:
  - the fresh challenge remains `RECEIVED`;
  - other paired-DM backlog is moved to `DEFERRED_BACKLOG`;
  - only after durable staging can local cursor advancement be attempted.
- One-shot uses an exclusive local lock to prevent a second one-shot instance on the same workspace.

## Next controlled acceptance

Before testing:

1. Confirm no other OpenClaw / LetterFerry / diagnostic consumer is running `getUpdates`.
2. Keep existing credentials and pairing; do not rescan.
3. Keep Weixin outbound disabled.

Then:

1. Start `Weixin Web One-Shot 1 Receive.cmd`.
2. Type `POLL WEIXIN ONCE` to authorize the test.
3. Wait for `WEIXIN_LISTENER_ARMED`.
4. Only then send the newly displayed challenge from the already paired Bot DM.
5. Preserve the exact `GETUPDATES_OUTCOME` line.
6. Do not retry an outbound send.

Interpretation:

- `server_messages` with the fresh challenge: inbound transport is verified; continue the existing two-stage acceptance.
- `server_empty` after a fresh challenge was sent while the poll was already armed: strong evidence for an upstream/account-delivery problem.
- `client_timeout`: transport remains unverified; do not classify it as server-empty.
- `error`: use the fixed error category and protocol metadata for diagnosis.

## Relevant upstream evidence

Tencent/openclaw-weixin has public reports with similar symptoms:

- #244: successful personal-account binding but empty `getUpdates` across multiple bindings.
- #267: empty inbound behavior even after correcting a long-poll timeout race.
- #268: a collaborator confirmed at least one separate delivery failure was affected by platform risk control.
- #278: a collaborator clarified that API-level success does not necessarily prove client delivery/display.

These reports show that upstream/account-level failure modes exist, but they do **not** prove the currently paired account is risk-controlled.

## Escalation

If the controlled armed-listener test still produces a genuine `server_empty` response after the fresh challenge was sent, prepare the redacted support report and ask the maintainer to inspect the current account's iLink subscription, bot mapping, delivery queue, and restriction state.

Do not repeatedly rebind, reinstall, clear credentials, or force cursor movement unless the maintainer explicitly asks for it.

## Privacy

Do not publish bot tokens, context tokens, full account IDs, full paired-peer IDs, chat bodies, browser profiles, keys, SQLite files, or local `data/` contents.

The generated support report intentionally contains fingerprints and protocol outcome metadata instead of raw identifiers.
