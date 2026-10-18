# Weixin inbound verification status

Status: **WEIXIN_INBOUND_VERIFIED / CHATGPT_BROWSER_HANDOFF_REQUIRES_CLEAN_COMPOSER**

Last updated: 2026-10-18

## Live proof obtained

A controlled one-shot test was completed with the listener already armed before the user sent the fresh challenge.

Observed sequence:

1. `notifyStart` succeeded.
2. `WEIXIN_LISTENER_ARMED` was printed before the challenge was sent.
3. Clean `server_empty` responses were safely re-armed inside the same bounded receive window.
4. The fresh challenge arrived on poll 4 as:
   - `GETUPDATES_OUTCOME=server_messages`
   - `http_status=200`
   - `raw_messages=1`
   - `paired_messages=1`
   - `cursor_changed=true`
5. The message was durably persisted before local cursor handling.
6. LetterFerry queued the authorized inbound event to the ChatGPT browser bridge.

This verifies that the current Weixin account, bot binding, iLink auth/baseurl, notify lifecycle, cursor flow, and paired-DM inbound path can deliver a real fresh message to LetterFerry.

## Browser handoff result

The downstream browser bridge did **not** submit the queued test prompt because the bound ChatGPT composer contained a human draft.

The browser failure was:

- stage: `BROWSER_DELIVERY`
- code: `COMPOSER_NOT_EMPTY`

The content script checks this condition before any browser input mutation and before the send button click. Existing regression coverage verifies that a human draft is not overwritten and no click occurs.

The linked adapter/Web Host records were later reviewed through the explicit no-replay workflow and both were archived as `REVIEWED_NO_REPLAY`.

No browser task was resent and no Weixin outbound reply was attempted.

## Current interpretation

The earlier status `WEIXIN_INBOUND_UNVERIFIED` is obsolete for this workstation/account pairing.

The remaining acceptance task is now narrower:

- use a dedicated/clean ChatGPT test conversation;
- ensure its composer is empty;
- bind and arm LetterFerry to that conversation;
- repeat one fresh controlled one-shot;
- verify ChatGPT reply capture;
- manually approve exactly one Weixin outbound reply;
- confirm receipt on the phone.

Do not repeat the already-reviewed unknown browser task.

## Reliability notes

- A single iLink long-poll may complete with `server_empty` well before 35 seconds; one observed clean empty response completed at about 18.3 seconds.
- The one-shot receiver therefore uses one bounded 90-second authorized receive window and may re-arm only after a clean `server_empty`.
- `client_timeout`, protocol errors, unrelated raw messages, or ambiguous states still stop immediately.
- LetterFerry can guarantee only whether its **local persisted cursor** changed; it cannot promise server-side replay semantics.
- Paired-DM messages observed by one-shot are durably staged before later local cursor handling.

## Privacy and safety

Do not publish bot tokens, context tokens, full account IDs, full paired-peer IDs, chat bodies, browser profiles, keys, SQLite files, or local `data/` contents.

The generated support report is a diagnostic snapshot only and must not be treated as the authoritative current acceptance state.