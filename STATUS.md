# Ratatoskr Status

**Last session:** 2026-06-20
**Branch:** main

## Completed This Session (2026-06-20)

### Fix: resilient listener bind (PR #11, deployed)

The `/api/send` listener binds the Pi's Tailscale IP (`HOST=100.97.117.37`).
`app.listen` had no `'error'` handler, so an `EADDRNOTAVAIL` bind failure
(tailscaled not up at boot, or a runtime tailnet blip) crash-looped the
**whole process — the Telegram bot included**, even though the bot needs no
tailnet. With Heimdall now routing its alerts through `POST /api/send`, the
listener's resilience matters beyond remote-send.

- New `src/listen.ts` — pure `decideBindRetry()` + thin `attachBindResilience()`
  wrapper (injectable schedule/exit/logger). Retries `EADDRNOTAVAIL` only,
  bounded at 60×/~5min, then exits so systemd `Restart=always` takes over.
- `src/index.ts` wires it in right after `app.listen`.
- `tests/listen.test.ts` — 10 tests (TDD red→green). Suite: **148 passing**, tsc clean.
- Converted the previously-"optional" bind-resilience patch in
  `docs/remote-send.md` into the shipped default; updated `ratatoskr.service` comment.
- Codex (gpt-5.5, xhigh) cross-model review: 0 critical, 0 medium, 1 low
  (doc drift — fixed in the same PR).
- Commits: `020b46a` (fix), squashed from `d4d1c72` + `c95e827`.
- **Deployed** to huginmunin via `deploy.sh` and verified live: `/health` 200 on
  `100.97.117.37:3034`, `bot_connected:true`, clean first-try bind, no retries.

### Tests: `/api/send` integration tests + testable seam (branch, pending PR)

The `POST /api/send` handler lived inline in `index.ts`, which boots the bot
and binds a port on import — so the route's validation and the
auth-before-json-parse ordering were untestable. Extracted into a seam:

- New `src/send-handler.ts` — `createSendHandler(deps)` (pure, DI'd
  `sendMessage`/`allowedUsers`/optional `logError`) + `registerSendRoute(app, deps)`
  wiring `requireSendApiKey → express.json() → handler` in order.
- `src/index.ts` — inline handler replaced with a 6-line `registerSendRoute(...)`;
  behavior preserved (review confirmed byte-for-byte equivalent).
- `tests/send-handler.test.ts` — 15 supertest integration + unit tests:
  `chat_id`→400 (incl. missing/string/empty/non-string variants), allowed-users→403,
  success→200 (asserts send args), throw→500, malformed/empty body, GET→404, and
  two ordering tests proving auth gates the JSON parser (malformed body on an
  unauthenticated bind → 401, not 400).
- devDeps: `supertest`, `@types/supertest`. Suite: **148 → 163**, tsc clean.
- Adversarial 3-lens review (equivalence/security/test-quality): equivalence &
  security clean; test-quality found a **false-green** malformed-JSON assertion
  (fixed with a discriminator) + missing cases (added).
- Commits `19f8c2e` (feat) + `1e23ec1` (STATUS) on branch
  `feat/api-send-integration-tests`; pushed. **PR #13 open**, awaiting review +
  merge (no CI configured for this repo; verified locally green).

## Completed since the last STATUS update (2026-04-23 → 2026-06-20)

All merged to main and deployed to the Pi:
- **Remote-send over Tailscale** (PR #10 + grimnir #32) — authenticated
  `POST /api/send` over the tailnet; laptop pings Telegram without SSH/YubiKey.
  Verified live 2026-06-18.
- **POST /api/send bearer auth** (PR #7) — timing-safe, fail-closed on
  non-loopback bind without a key (`src/auth.ts`).
- **Reply-awareness for untracked alerts** (PR #8) — carries replied-to text
  into the concierge.
- **Munin consolidation-worker health alerting** (PR #6) —
  `src/consolidation-health-poller.ts`, Telegram alert on failure/recovery.

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
- **`/api/send` integration tests** — **PR #13 open**
  (`feat/api-send-integration-tests`), green + reviewed, awaiting human review +
  merge. See "Completed This Session" above.

## Next Steps
- **Deploy signing secret** to Pi env: set `RATATOSKR_SIGNING_SECRET`
  (64-char hex) and the matching `HUGIN_SUBMITTER_KEYS` entry
  `{"ratatoskr": "<same-hex>"}` on Hugin. Flip `HUGIN_SIGNING_POLICY=warn`
  to watch for stragglers. (PR #5 code is shipped but dormant until provisioned.)
- "Task picked up" intermediate notification (#2) — ack on first in-progress transition
- Concierge per-user rate limiting / debounce (#3)
- Non-text messages (#1): voice transcription + document routing (photos already work)
- Prior backlog: grimnir #31 (restart-after-dep-upgrade); pendingReplyContext per-message keying
