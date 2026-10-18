# Weixin upstream blocker

Status: **BLOCKED UPSTREAM / ACCOUNT-DELIVERY DIMENSION NOT YET RESOLVED**

Last verified: 2026-10-18

## What is already verified locally

- ChatGPT Web bridge smoke passed with exact `SUCCEEDED + RIVEN_WEB_SMOKE_OK`.
- Weixin credentials exist and one exact DM peer is paired.
- `notifyStart` succeeds.
- `getUpdates` returns zero inbound messages.
- A read-only empty-cursor diagnostic also returns zero inbound messages.
- `notifyStop` succeeds.
- No diagnostic committed the upstream cursor.
- No Weixin outbound reply was sent during the failed inbound checks.
- Local suite: **296/296 PASS**.
- `npm run check`: PASS.

The tested local causes have therefore been ruled out: browser delivery, ChatGPT route binding, local envelope filtering, durable cursor advancement, omitted notify lifecycle, and a short message-arrival timing window.

## Relevant upstream evidence

Tencent/openclaw-weixin has several open reports with closely matching behavior:

- #244: successful personal-account binding, but `getUpdates` remains empty across multiple bindings.
- #267: same empty inbound behavior even after correcting the 35s/45s long-poll timeout race.
- #268: a Tencent repository collaborator confirmed at least one delivery-failure case was affected by platform risk control and expected recovery after intervention.
- #278: a collaborator clarified that API `ret=0` means accepted/processed at the API layer and does **not** guarantee that the Weixin client receives or displays the message.

These reports do **not** prove the currently paired account is risk-controlled. They show that an upstream/account-delivery failure mode is real and can survive local reinstall/rebind attempts.

## Current safety policy

Until paired-DM inbound traffic is visible again:

1. Do not repeatedly rebind or reinstall.
2. Do not replay ambiguous outbound sends.
3. Do not force or fake cursor advancement.
4. Use `Check Weixin Inbound Health.cmd` for a read-only health check.
5. Use `Generate Weixin Support Report.cmd` when a redacted diagnostic bundle is needed.
6. Resume the real one-shot receive acceptance only after the health check reports `WEIXIN_INBOUND_AVAILABLE`.

## Privacy

Do not publish bot tokens, context tokens, full account IDs, full paired-peer IDs, chat bodies, browser profiles, keys, SQLite files, or local `data/` contents.

The generated support report intentionally contains fingerprints and counts instead of raw identifiers.
