# Ratatoskr Status

**Last session:** 2026-07-13 (Codex) — Heimdall alert-resolution transport implemented locally
**Branch:** `agent/alert-resolution-transport` (isolated worktree: `/private/tmp/ratatoskr-alert-resolution`)

## Current Session (2026-07-13) — alert lifecycle transport pending review

Implemented the Ratatoskr side of Heimdall's resolved-alert contract on top of
`origin/main` at `2657ceb` (merged PRs #46/#47). The alert validator now keeps a
strict firing/resolved distinction: firing alerts still require a nonempty title;
`state:"resolved"` events may omit title but require a trimmed nonempty
`dedup_key`. Unknown states and incomplete lifecycle events are rejected.

Resolution-only `/api/send` requests still pass the existing Bearer-auth and
Telegram chat allowlist gates, then forward the clean `{state:"resolved",
dedup_key}` envelope to Heimdall without manufacturing a Telegram message.
Explicit text still wins and retains the existing send-before-best-effort-echo
ordering. No producer keys or unrelated alert behavior were added.

### Remaining / next

- Parent fallback review, then push/open the focused PR.
- Wait for green CI/review before merge.
- Deploy only after merge and verify authenticated firing + resolution transport
  against the live Heimdall ingest without creating new producer alerts.

## Completed This Session (2026-07-13) — deploy artifact hardening PR #47

PR #46 merged as `1103658` and was deployed successfully, but deploying its
clean detached worktree exposed an rsync edge case: a worktree represents `.git`
as a file, while `deploy-pi.sh` excluded only `.git/`. The dangling workstation
gitdir pointer was copied into the Pi artifact directory. Production was repaired
immediately by removing that remote `.git`; the service, exact deployed marker,
and health were reverified.

This branch excludes `.git` regardless of whether it is a file or directory,
removes deploy-target Git metadata before every remote sync, and uses
`npm ci --omit=dev` for deterministic production dependency installation. The
fake-fleet regression runs from a synthetic source worktree containing a `.git`
file and verifies exclusion, cleanup ordering, lockfile install, and the existing
fail-closed/exact-SHA marker behavior without contacting a host.

PR #47 merged as `2657ceb`. This session did not change deployment state; verify
the live deployed marker before the next rollout.

## Completed This Session (2026-07-13) — core hardening PR #46

Implemented the approved no-new-functionality hardening scope on top of
`origin/main` at `6de08bf`: reliable at-least-once terminal result delivery,
UUID-backed task IDs, strict bounded concierge decisions with encoded untrusted
context boundaries, CAS-safe cancellation that preserves provenance tags, and
bounded/shutdown-aware Munin, Anthropic, M5, and Telegram requests. Initial
implementation commit: `fcd1802`; the follow-up commit addresses the final
fallback-review findings for cancellation tags and hostile closing-tag payloads.

Local validation is green: full Vitest suite, focused hardening regressions,
TypeScript build, and `git diff --check`. The dependency audit remains unchanged
and intentionally outside this branch: 3 moderate production findings; 7 total
including development dependencies.

PR #46 merged as `1103658`, passed review and GitHub checks, and was deployed.
The deployment artifact regression and its correction are recorded in the
current-session section above.

## Completed This Session (2026-07-13) — issue sweep + Claude-reviewed deployment

Imported the Claude-facing project guidance for Codex and completed every open
Ratatoskr issue that had a concrete autonomous fix. Each implementation used an
isolated worktree/branch, a draft PR, GitHub Actions, and iterative Claude Opus
review before squash merge:

- **PR #41** (`c1ff58e`) — added byte-identical `AGENTS.md` guidance plus a
  regression test that prevents drift from `CLAUDE.md`.
- **Issue #26 / PR #43** (`1f959e1`) — added `scripts/ratatoskr send`, which
  works when the service is stopped, parses only required systemd env scalars,
  keeps the bot token out of argv/environment/output, bounds retries/time, and
  documents the tailnet and explicit-account Himalaya paths.
- **Issue #1 / PR #42** (`c82e25b`) — completed Telegram document handling for
  bounded PDF/TXT/Markdown/CSV/JSON files. Documents stay attached through a
  10-minute clarification loop, are persisted privately for Hugin ready tasks,
  and get cleanup/30-day retention; cloud document reading can be disabled.
- **Issue #40 / PR #44** (`31b62a4`) — added the authenticated durable reminder
  API (create/list/status/cancel), fsynced atomic persistence, per-chat
  idempotency, bounded queue/timeouts, explicit at-most-once attempt semantics,
  corruption quarantine, restart recovery, and content-blind health metrics.
- **PR #45** — fixed the deployment provenance regression discovered during
  rollout. Remote deploys require a clean exact Git source; in-place Pi deploys
  require explicit `DEPLOY_COMMIT`; stale markers are removed before mutation
  and the new marker is written only after restart/status succeeds. Behavioral
  fake-fleet tests cover both paths and failure guards.

Final combined verification: TypeScript clean, guidance byte-identical, GitHub
Actions green for every PR, and the complete local suite green. Production on
`huginmunin` is active with `bot_connected:true`, reminder counts 0/0, reminder
store mode `0600`, authenticated reminder listing healthy, and `.deployed-commit`
matching the deployed main revision.

### Remaining

- Open issue #4 is an intentionally ongoing operational checklist for *future*
  private repos. It needs a concrete repo/collaborator target, so it was left open.
- Existing dependency audit findings remain separate: 7 total locally and 3
  moderate production findings on the Pi.

## Completed This Session (2026-07-08) — `/repo` hardening live validation

Validated the deployed `/repo` command path on `huginmunin` using Ratatoskr's production built
modules, real `.env`, and real Munin target. The synthetic Telegram update used the actual
`createBot` command handler with a local Bot API interceptor, so no external Telegram message was
sent.

- Accepted case: `/repo heimdall ...` created
  `tasks/20260708-180247-ratatoskr-command-handler-live`, then the validator immediately changed it
  to `cancelled` to avoid execution.
- Accepted task evidence: content includes `**Context:** repo:heimdall`, signed
  `Submitted by: ratatoskr`, and `Working directory: /home/magnus/repos/heimdall`.
- Rejected traversal case: `/repo ../../etc ...` raised
  `Invalid repo context: "repo:../../etc"` and replied `Error submitting task. Check logs.`
- Rejected header-injection case: `/repo heimdall\n**Timeout:** 999999 ...` raised
  `Invalid repo context: "repo:heimdall\n**Timeout:**"` and replied `Error submitting task. Check logs.`
- Munin audit evidence after the command-handler probe shows exactly one task write and one immediate
  cancellation update, both for the accepted task; no task write for either rejected case.
- Live health after validation: `ratatoskr.service` active, `/health` returns `status:"ok"`,
  `bot_connected:true`, `active_polls:0`; Hugin `/health` reports `current_task:null` and
  `queue_depth:0`.

### Pending / next

- Triage the existing npm audit findings separately; do not mix that with repo-context validation.
- Consider improving the user-facing rejection reply later; it is currently generic by design
  (`Error submitting task. Check logs.`), while the precise reason is logged server-side.

## Completed This Session (2026-07-08) — production marker repair + main deploy

Grimnir validation found Ratatoskr healthy but missing its `.deployed-commit` marker on
`huginmunin`, so Heimdall/Grimnir could not prove what rsync deployment was live. Local `main` was
clean at `ce3fc5d` (`feat: pass M5 triage delegator model (#39)`), and GitHub CI for that exact SHA
had passed.

Deployed via `/Users/magnus/repos/grimnir/scripts/deploy.sh ratatoskr`.

- Remote marker: `/home/magnus/repos/ratatoskr/.deployed-commit` =
  `ce3fc5d06af6f12320906fc2607c11e966e40a14`.
- Live service: `ratatoskr.service` is active.
- Health: `/health` returns `status:"ok"`, `service:"ratatoskr"`, `bot_connected:true`,
  `active_polls:0`.
- Follow-up Grimnir validation: **7 ok, 0 issues, 0 warnings**.
- Deploy caveat: npm audit still reports existing dependency issues (local: 7 total, production:
  3 moderate); this was not changed during the marker repair.

### Pending / next

- Completed live `/repo` validation on 2026-07-08; npm audit findings remain separate follow-up work.

## Completed This Session (2026-07-07) — ratatoskr#36 repo-context hardening

Added a task-writer guard for `repo:<name>` contexts before any Hugin task is written:

- Accepts only `scratch` or `repo:<safe-token>`.
- Rejects path traversal, slashes, whitespace, newlines/header injection, and unknown repos.
- Adds `RATATOSKR_ALLOWED_REPOS` with a default allowlist matching Grimnir component repos.
- Covers both `/repo` command submissions and concierge/LLM-produced `ready.task.context`, because
  both flow through `submitTask`.

PR #37 merged as `356ec3e` after local test/build validation, M5 review, and green GitHub checks.

### Pending / next
- Deployed and live-validated on huginmunin on 2026-07-08.

## Completed This Session (2026-06-24) — autonomous, 4 PRs merged + deployed

All four landed test-first (red→green), each with a cross-model Codex review
(gpt-5.5, xhigh) whose findings were fixed before merge (#16 also got a 4-lens
adversarial workflow review). Suite grew **163 → 238**, tsc clean throughout.
**Deployed to huginmunin** — `/health` 200, `bot_connected:true`, clean bind.
Voice (#1) + the Heimdall echo (#16) are live but dormant until their env vars
are provisioned.

### #1 Voice messages via a local Whisper endpoint (PR #21, merged `9e2b964`)
New `src/transcribe.ts` (`createTranscriber` → OpenAI-compatible
`/v1/audio/transcriptions`; `checkVoiceLimits` pure guard) + `downloadFile` in
telegram-file. `message:voice` handler: config-gated → rate-limited → duration/
size-guarded → download → transcribe → echo (capped) → triage. Refactor: the
duplicated triage-result switch in the text + photo paths was extracted into a
shared `handleTriageResult` (Codex confirmed behavior-preserving). Privacy: warns
if `RATATOSKR_TRANSCRIBE_URL` isn't local unless `…_ALLOW_REMOTE=true`. Audio
stays on-box. **Document routing (PDF/txt) remains a follow-up.**

### #16 Alert bus on POST /api/send (PR #17, merged `f713479`)
`/api/send` now accepts an optional standard `alert` envelope: renders a Telegram
message from it when `text` is absent, and best-effort echoes the envelope to
Heimdall's fail-closed `/api/alerts` ingest (`HEIMDALL_INGEST_URL` +
`HEIMDALL_ALERT_TOKEN`; both required, else echo skipped). New `src/alert.ts`
(`validateAlert` rebuilds a clean allowlisted/type-checked envelope incl. http(s)-
only link validation; `renderAlertText` self-bounds to 4096; `createHeimdallNotifier`,
3s timeout). Codex fixes: truncation, allowlisted rebuild, log hygiene, both-vars
gating + config warning.

### #2 "Picked up" ack on first in-progress transition (PR #18, merged `3267d4d`)
`ResultPoller.startPolling` gains an optional `onPickup` — fires once on the first
`running` observation, de-duped by an in-memory guard + a persisted Munin `pickup`
marker (no re-ack across restart). Wired into all 4 bot task paths + recovery.
Codex fixes: per-task `polling` serialization guard (no overlapping polls →
no double-deliver / out-of-order pickup), marker written only after a successful
ack (retries on failure).

### #3 Per-user concierge rate limit (PR #19, merged `519be4a`)
New `src/rate-limiter.ts` (`SlidingWindowRateLimiter`, pure/time-injectable) caps
Haiku triage calls per chat (`RATATOSKR_CONCIERGE_RATE_LIMIT`=8 /
`_WINDOW_MS`=60000). Gates both text + photo paths; over-limit → throttled "slow
down" notice. Codex fixes: consume reply-context before the gate (no leak),
sanitize NaN/≤0 config to safe defaults, evict empty limiter keys, `.env.example`.

## Earlier — 2026-06-20

## Completed (2026-06-20)

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
- Cross-model Codex review (gpt-5.5, xhigh): clean, zero findings.
- **Merged** to main via PR #13 (squash `d841f02`) and **deployed** to
  huginmunin — service active, `/health` 200 with `bot_connected:true`
  (rsync excludes `tests/`; verified live 2026-06-20). Test-only + pure
  refactor, so no runtime behavior change.

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
- Nothing — all changes merged and deployed.

## Ops session 2026-06-24 (provisioning) — outcomes

Recon found the documented plan was stale; resolved all three:
- **Signing (PR #5): already provisioned** — verified on-box `RATATOSKR_SIGNING_SECRET`
  == Hugin `HUGIN_SUBMITTER_KEYS["ratatoskr"]`, `HUGIN_SIGNING_POLICY=warn`. No change.
- **Heimdall echo (#16): LIVE** — Heimdall had no `HEIMDALL_ALERT_TOKEN` (rejected all);
  generated a shared token, set it on Heimdall (systemd drop-in) + Ratatoskr `.env`,
  verified wrong→401 / right→200.
- **Voice (#1): LIVE** — reused the existing **KB-Whisper (Swedish)** server on m5,
  rebound from loopback to the Tailscale IP (`100.76.72.59:8092`, `--convert`), wired
  `RATATOSKR_TRANSCRIBE_URL` on the Pi. OGG→transcript + Pi→m5 path verified. (Note: an
  accidental overwrite of m5's `whisper-server.service` was caught + restored.)

## Next Steps
- **✅ Voice (#1) confirmed LIVE** — m5 is back; `whisper-server.service` auto-recovered
  tailnet-bound on `100.76.72.59:8092`, and a real Telegram voice note transcribed via
  KB-Whisper and the bot replied (logs clean). Done.
- **Optional live check:** exercise the alert-envelope path — `POST /api/send`
  `{chat_id, alert}` → Telegram + Heimdall strip (infra verified 401/200, not yet run
  with a real alert).
- **m5 caveat:** KB-Whisper is now tailnet-bound (not loopback) — update any local-only
  m5 consumer of `127.0.0.1:8092` to `100.76.72.59:8092`, or rebind `0.0.0.0`.
- **#1 follow-up:** document routing (PDF/txt) — separate from transcription.
- **Separate:** Munin consolidation worker flagged `failing` (the bot alerted on Telegram)
  — investigate in the Munin project.
- Prior backlog: grimnir #31 (restart-after-dep-upgrade); pendingReplyContext
  per-message keying.
