# Weixin ↔ ChatGPT end-to-end acceptance status

Status: **END_TO_END_ACCEPTED**

Last updated: 2026-10-18

## Final live acceptance

A controlled one-shot test completed the full path on this workstation and paired Weixin Bot DM:

1. The dedicated ChatGPT test conversation was bound and armed with an empty composer.
2. `notifyStart` succeeded and `WEIXIN_LISTENER_ARMED` was printed before the fresh challenge was sent.
3. Clean `server_empty` responses were re-armed only inside the same bounded 90-second authorized receive window.
4. The fresh challenge arrived on poll 5 with:
   - `GETUPDATES_OUTCOME=server_messages`
   - `http_status=200`
   - `raw_messages=1`
   - `paired_messages=1`
   - `cursor_changed=true`
5. The paired-DM message was durably persisted before local cursor handling.
6. LetterFerry queued the message to the dedicated ChatGPT browser conversation.
7. A real ChatGPT reply was captured and held locally as:
   - `ONE_SHOT_READY_FOR_OWNER_REVIEW`
   - `Weixin outbound calls=0`
8. After explicit human approval, exactly one Weixin outbound call was made:
   - `ONE_SHOT_WEIXIN_API_ACCEPTED`
   - `Outbound calls=1`
9. The user confirmed the reply was actually visible on the phone in the paired Weixin DM.
10. Final local database check returned:
    - `adapterUnsafe=0`
    - `webUnsafe=0`
    - `safe=true`

This is a complete end-to-end acceptance of the current text path:
**Weixin DM → LetterFerry → bound ChatGPT Web conversation → ChatGPT reply → LetterFerry → Weixin DM**.

## Earlier browser collision and recovery

An earlier live attempt successfully verified Weixin inbound, but the browser handoff stopped at:

- stage: `BROWSER_DELIVERY`
- code: `COMPOSER_NOT_EMPTY`

That happened because the bound ChatGPT conversation was also being used interactively and contained a human draft. The content script checks this condition before any input mutation and before the send click, so it did not overwrite the draft or submit the bridge task.

The linked adapter/Web Host records were reviewed through the explicit no-replay workflow and archived as `REVIEWED_NO_REPLAY`. No browser task was resent and no Weixin outbound reply was attempted from that ambiguous event.

A dedicated ChatGPT test conversation was then used for the final successful acceptance.

## Current acceptance scope

Verified now:

- protected Weixin credentials and paired-DM binding;
- iLink auth/baseurl and notify lifecycle;
- fresh paired-DM inbound delivery;
- bounded clean-empty poll re-arming;
- durable local staging and cursor handling;
- local Web Host and Edge extension bridge;
- dedicated ChatGPT conversation submit and reply capture;
- manual one-time Weixin outbound approval;
- actual phone-side receipt;
- no automatic retry on ambiguous delivery;
- final local stores returned to `safe=true`.

Still not claimed by this acceptance:

- unattended long-running service;
- multiple peers or group chat;
- voice;
- production image sending/receiving;
- arbitrary browser layouts beyond the tested compatibility surface;
- guaranteed iLink server-side replay semantics.

## Reliability notes

- One iLink long-poll may return `server_empty` in roughly 18 seconds rather than waiting for the client timeout.
- The one-shot receiver therefore uses one bounded 90-second authorization window and only re-arms after a clean `server_empty`.
- `client_timeout`, protocol errors, unrelated raw messages, and ambiguous states still stop rather than auto-retry.
- LetterFerry can state whether its **local persisted cursor** changed; it does not claim control over upstream server replay behavior.
- Browser `COMPOSER_NOT_EMPTY` is a pre-send safety stop and is eligible for explicit no-replay review only when all linked one-shot invariants match.

## Validation

Latest independent isolated-checkout suite: **303/303 PASS**.

`npm run check`: **PASS**.

Independent review also added regression coverage confirming that a response-body timeout retains an HTTP status already received in the headers; a timeout before headers still reports no status.

## Privacy and safety

Do not publish bot tokens, context tokens, full account IDs, paired-peer identifiers, chat bodies, browser profiles, keys, SQLite files, or local `data/` contents.

The generated support report is a diagnostic snapshot only. This document is the current project acceptance record for the verified text path.