# Ratatoskr Status

**Last session:** 2026-04-23
**Branch:** main

## Completed This Session (2026-04-23)

### Feature: HMAC-SHA256 task submission signing

Wire Ratatoskr into Hugin's v1 signing scheme (see
`hugin/docs/security/task-signing.md`).

- New `src/task-signing.ts` — mirrors hugin's canonicalization
  (`buildCanonicalPayload`, `signTask`, `canonicalizePrompt`).
- `src/task-writer.ts` embeds `**Signature:** v1:<keyId>:<hex>` in the
  task body when `RATATOSKR_SIGNING_SECRET` is set; omits it when unset
  (backwards-compat default during rollout).
- Config adds `RATATOSKR_SIGNING_SECRET` and
  `RATATOSKR_SIGNING_KEY_ID` (default `ratatoskr`).
- Tests: 9 new signing tests including a cross-language drift guard
  that spawns `hugin/scripts/sign-task.mjs` and asserts byte-equal
  output. All 93 tests passing, build green.

Rollout: unsigned by default on Pi until the env var is set. Hugin
remains on `HUGIN_SIGNING_POLICY=off` — flipping to `warn` needs the
secret deployed on both sides.

## Completed 2026-04-04

- `1f3d3ec` feat: soul definition + result formatting (Hugin task)
  - Created `src/soul.ts` with `RATATOSKR_SOUL` constant
  - `extractResultBody()`, `formatResult()`, `shortId()`, `STATUS_MESSAGES` in telegram-util.ts
  - Soul injected into concierge system prompt
  - All result delivery paths switched from raw `truncateResult` to `formatResult`
- `ff58dea` feat: reply-to-message awareness (Hugin task)
  - `MessageTracker` maps outbound Telegram message IDs to context
  - Concierge receives reply context when user swipe-replies
- `20bd1e6` feat: photo/image support (Hugin task)
  - `message:photo` handler downloads images via Telegram file API
  - Concierge uses Haiku vision (multimodal) to interpret images
  - Images stay at concierge layer — described in text for Hugin tasks
- `25151ff` fix: strip markdown from Hugin responses
  - `stripMarkdown()` converts all markdown syntax to plain text
- `1dc8ba2` fix: surface concierge error reasons in Telegram
  - Classifies errors (rate limit, timeout, parse failure, etc.) instead of generic message
- `9e4442a` feat: summarize task results via Haiku
  - `summarizeResult()` sends stripped body through Haiku with soul prompt
  - Produces terse 2-3 sentence summaries instead of verbose reports
  - Falls back to stripped body if summarization fails

## Completed Previously
- Poll recovery, delivery confirmation, conversation persistence (`659a1ab`)
- POST /api/send endpoint for outbound Telegram messages (`ae4f64a`)
- Full Ratatoskr implementation: bot, concierge, task submission, result polling (`bd28ebc`)
- Deployed on Pi (huginmunin), systemd service, Heimdall monitoring

## In Progress
- Nothing — all changes deployed

## Next Steps
- **Deploy signing secret** to Pi env: set `RATATOSKR_SIGNING_SECRET`
  (64-char hex) and the matching `HUGIN_SUBMITTER_KEYS` entry
  `{"ratatoskr": "<same-hex>"}` on Hugin. Flip `HUGIN_SIGNING_POLICY=warn`
  to watch for stragglers.
- Test the full pipeline end-to-end: submit a task via Telegram, verify result comes back summarized in Ratatoskr's voice
- Consider "task picked up" intermediate notifications (running status)
- Consider voice message support
- Consider document/file handling
