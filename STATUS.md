# Ratatoskr Status

**Last session:** 2026-06-17
**Branch:** main

## Completed This Session (2026-06-17)

### Fix: reply-awareness for proactive alerts (PR #8 — merged + deployed + verified)

Replying in Telegram to a bot-pushed proactive alert (e.g. the Munin
"consolidation worker TRIPPED" message) lost all context — the concierge
answered "what's bad?". Root cause: reply-awareness relied solely on the
in-memory `MessageTracker`, and proactive alerts (sent from
`consolidation-health-poller.ts`) were never registered, so
`messageTracker.lookup()` returned `null` and no Reply Context reached Haiku.

- New pure helper `buildReplyContext(repliedTo, tracked)` in `src/bot.ts` reads
  the replied-to body from Telegram's own `reply_to_message.text/caption`
  (tracker-independent), merged with the tracker result when present. Used by
  both the text and photo handlers.
- `src/concierge.ts` prefers `replyToText` (1000-char cap), falling back to the
  tracker snippet/taskId path.
- `TrackedMessage` gains optional `replyToText`.
- Tests: test-first red→green + `buildReplyContext` unit tests. 133 passing,
  `tsc` clean. Independent (same-model) adversarial review: ship.
- Deployed to Pi and verified live: replying "can you fix it?" to the alert
  submitted a correctly-scoped Hugin task instead of clarifying. PR #8 merged.

### Cross-repo incident triage (spawned from the reply-awareness test)

The alert reply surfaced a ~2-day silent outage of the whole Hugin task system.
Detail in Munin `projects/hugin` and `projects/munin-memory`.

- **Hugin executor outage** — every agent-sdk task died instantly with an opaque
  `exit 1`. Root cause: a Jun-15 deps-bump hot-swapped
  `@anthropic-ai/claude-agent-sdk` + its native binary while the long-running
  worker kept the OLD SDK in memory. Fixed via `systemctl --user restart hugin.service`.
- **hugin#114** (merged + deployed) — `sdk-executor` now captures child stderr,
  so this class of failure is diagnosable in minutes.
- **munin-memory#125** (merged + deployed + verified draining) — idempotent
  `ON CONFLICT` upsert for `cross_references` + dedup + self-healing circuit
  breaker. Closes the original "TRIPPED" incident.
- **grimnir#31** filed — dep-bumps don't restart the services they upgrade (the
  outage's root cause); added to the Roadmap board.

## Completed 2026-04-23

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
secret deployed on both sides. (Note 2026-06-17: Hugin is now on
`HUGIN_SIGNING_POLICY=warn`.)

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
- Nothing — all changes merged, deployed, and verified.

## Blockers
- None.

## Next Steps
- (optional) Permanent fix for grimnir#31 — restart services after a dependency upgrade.
- (optional) Pre-existing race: `pendingReplyContext` keyed by `chatId` can clobber
  reply context within the ~2.5s aggregation window — consider per-message keying.
- (optional) CLAUDE.md component note for `buildReplyContext` / `replyToText`.
- (carried) "task picked up" intermediate notifications (running status).
- (carried) Voice message support; document/file handling.
