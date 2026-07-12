# Ratatoskr

## What this project is

Ratatoskr is a Telegram router and concierge for the Grimnir personal AI system. Named after the squirrel that carries messages between the eagle and serpent on Yggdrasil. It lets Magnus interact with Grimnir from Telegram — sending tasks from a phone and receiving results back.

Part of the Grimnir system: **Munin** (memory), **Hugin** (task dispatcher), **Ratatoskr** (Telegram router).

## Architecture

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Framework:** Express (health endpoint only) + grammy (Telegram bot)
- **AI:** @anthropic-ai/sdk (Haiku for intent triage via concierge layer)
- **Deployment:** systemd on Pi 1 (huginmunin), port 3034
- **Telegram mode:** Long-polling (no webhook, no inbound HTTP)

### How it works

1. Telegram message arrives from allowlisted user
2. Concierge layer calls Claude Haiku with message + Munin context
3. Haiku decides: ready (submit task), clarify (ask user), or answer (reply directly)
4. If ready: task-writer formats Hugin task and writes to Munin
5. Result-poller monitors task completion and replies on Telegram

### Components

- `src/index.ts` — Express app (health endpoint + registers `/api/send` route) + bot startup + poll recovery
- `src/bot.ts` — Telegram bot setup, message/photo/voice/document handlers, allowlist, conversation persistence; shared `handleTriageResult` drives submit/clarify/answer for all input types, and fire-and-forget logs each triage decision to Munin (`ratatoskr/triage`) + records it in `TriageStats` (issue #27)
- `src/concierge.ts` — Intent triage (multimodal: text + images) + result summarization. Text triage classification routes through the M5 gateway's `POST /delegate` when `RATATOSKR_TRIAGE_URL` is set (issue #31) — the gateway records each attempt in the Pillar-2 capability ledger — with graceful, visible fallback to the Anthropic Haiku path on any gateway error/timeout; image triage and summarization stay on Anthropic. `triage()` returns a `meta` field (serving backend, model, fallback flag, per-attempt routing outcomes, latency, tokens) alongside the action (issues #27/#31)
- `src/triage-stats.ts` — `TriageStats`: in-memory (process-lifetime) tally of triage decisions by action + serving backend + M5 fallbacks + avg latency/tokens, read by `/heimdall.json` for real competence metrics (issues #27/#31)
- `src/soul.ts` — `RATATOSKR_SOUL` constant defining Ratatoskr's voice/personality for all Telegram output
- `src/task-writer.ts` — Format task markdown, write to Munin (with instance tag)
- `src/result-poller.ts` — Poll Munin for task results, delivery confirmation; fires a one-time "picked up" ack on the first `running` transition (issue #2), de-duped via a persisted Munin marker so a restart doesn't re-announce
- `src/recovery.ts` — Startup recovery: reattach polls, deliver undelivered results
- `src/munin-client.ts` — HTTP client for Munin JSON-RPC API
- `src/descriptor.ts` — `buildHeimdallDescriptor(state)`: builds the `/heimdall.json` body with `status`/`metrics` computed from live state (bot connection, active polls, triage stats) rather than hardcoded (issue #27)
- `src/telegram-util.ts` — Result formatting: metadata extraction, markdown stripping, summarization pipeline, truncation
- `src/telegram-file.ts` — Download media from Telegram's file API: `downloadPhoto` (base64 image) + `downloadFile` (raw bytes for voice/audio, issue #1)
- `src/transcribe.ts` — `createTranscriber`: posts audio to a local OpenAI-compatible `/v1/audio/transcriptions` Whisper endpoint (config-gated, audio stays on-box) and returns the transcript (issue #1)
- `src/document.ts` — validates PDF/text document type and size, converts Telegram downloads into bounded Anthropic document blocks, and rejects invalid UTF-8 (issue #1)
- `src/document-store.ts` — persists original Telegram document bytes under a private Pi-local path that downstream Hugin tasks can read; cleans non-task files and prunes ready-task attachments after 30 days (issue #1)
- `src/message-tracker.ts` — In-memory tracker mapping outbound Telegram message IDs to context (for reply awareness)
- `src/message-aggregator.ts` — Debounce rapid Telegram message fragments into single logical messages
- `src/rate-limiter.ts` — `SlidingWindowRateLimiter`: per-key sliding-window limiter (pure, time-injectable). Caps concierge/Haiku triage calls per chat so a message burst can't fan out into unbounded API calls (issue #3)
- `src/auth.ts` — Bearer-token middleware for `POST /api/send` (timing-safe; fail-closed when bound non-loopback without a key)
- `src/send-handler.ts` — `POST /api/send` route: `createSendHandler` (pure, DI'd handler — validation → allowlist → send → best-effort Heimdall echo) + `registerSendRoute` (wires auth → `express.json()` → handler in order). Extracted from `index.ts` as the testable seam (tested in `tests/send-handler.test.ts`). Accepts `{chat_id, text}` and/or `{chat_id, alert}` (issue #16)
- `src/reminders.ts` — fsynced/atomic Pi-local reminder store and bounded delivery scheduler with restart quarantine, 90-day terminal retention, idempotency, and at-most-once attempt semantics; `src/reminder-handler.ts` exposes authenticated create/list/status/cancel routes (issue #40)
- `src/alert.ts` — alert-bus support for `/api/send` (issue #16): `AlertEnvelope` type, `validateAlert` (rebuilds a clean allowlisted envelope from untrusted input), `renderAlertText` (severity header + body + links, self-bounded to Telegram's 4096 limit), `createHeimdallNotifier` (best-effort POST of the envelope to Heimdall's `/api/alerts` ingest)
- `src/consolidation-health-poller.ts` — Poll Munin consolidation-worker health; Telegram alert on failure/recovery
- `src/listen.ts` — Resilient HTTP listener bind: retry `EADDRNOTAVAIL` (Tailscale IP not yet assigned) instead of crash-looping the process
- `src/config.ts` — Environment configuration

## How to build

```bash
npm install
npm run build
```

## How to test

```bash
npm test
```

## How to run locally

```bash
TELEGRAM_BOT_TOKEN=<token> TELEGRAM_ALLOWED_USERS=<user_id> MUNIN_API_KEY=<key> npm run dev
```

## Deployment

```bash
./scripts/deploy-pi.sh [hostname]
```

Default host: `huginmunin.local`.

### Operational notifications

On the Pi, `./scripts/ratatoskr send <text>` reads the deployed `.env` and calls
Telegram directly, so it works even when `ratatoskr.service` is stopped. For the
authenticated HTTP path, use `http://${HOST:-127.0.0.1}:${PORT:-3034}/api/send`;
production is bound to the Tailscale address, not loopback. See
`docs/remote-send.md` for the exact recipe and the Himalaya email fallback.

The Pi needs a `.env` file at `/home/magnus/repos/ratatoskr/.env`:
```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_ALLOWED_USERS=<magnus telegram user id>
ANTHROPIC_API_KEY=<for concierge Haiku calls>
MUNIN_API_KEY=<same key Munin/Hugin use>
```

To let trusted tailnet hosts trigger Telegram pings without SSH/on-box access,
see **`docs/remote-send.md`** (bind `HOST` to the Tailscale IP + set
`RATATOSKR_SEND_API_KEY`).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3034` | Health endpoint port |
| `HOST` | `127.0.0.1` | Bind address. Set to the Pi's Tailscale IP to enable authenticated remote send (requires `RATATOSKR_SEND_API_KEY`). See `docs/remote-send.md`. |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather (required) |
| `TELEGRAM_ALLOWED_USERS` | — | Comma-separated Telegram user IDs (required) |
| `ANTHROPIC_API_KEY` | — | API key for concierge Haiku calls (required) |
| `CONCIERGE_MODEL` | `claude-haiku-4-5-20251001` | Model for intent triage |
| `MUNIN_URL` | `http://localhost:3030` | Munin HTTP endpoint |
| `MUNIN_API_KEY` | — | Bearer token for Munin (required) |
| `POLL_INTERVAL_MS` | `30000` | How often to check task results |
| `MAX_POLL_DURATION_MS` | `7200000` | Stop polling after this (2x default task timeout) |
| `RATATOSKR_INSTANCE_ID` | `default` | Instance identifier for multi-instance isolation |
| `REPOS_BASE_PATH` | `/home/magnus/repos` | Base path for resolving `repo:<name>` context to filesystem paths |
| `RATATOSKR_ALLOWED_REPOS` | Grimnir component repos | Comma-separated allowlist for `repo:<name>` task contexts. Invalid, unknown, path-like, or newline-containing repo contexts are rejected in `task-writer` before a Hugin task is written. |
| `RATATOSKR_SEND_API_KEY` | — | Bearer token for `POST /api/send`. Mandatory when `HOST` is non-loopback (the endpoint is disabled otherwise); when set, enforced on **all** binds incl. loopback. See `docs/remote-send.md`. |
| `RATATOSKR_CHAT_ID` | first `TELEGRAM_ALLOWED_USERS` entry | Optional default destination for `./scripts/ratatoskr send`; supports private and negative group/channel IDs. |
| `RATATOSKR_REMINDER_STORE` | `~/.local/state/ratatoskr/reminders.json` | Durable JSON store for scheduled reminders. Written atomically with mode `0600`; keep it outside the rsynced repo so deploys cannot delete it. |
| `RATATOSKR_SIGNING_SECRET` | — | HMAC-SHA256 secret for Hugin task submission signing (PR #5) |
| `RATATOSKR_SIGNING_KEY_ID` | `ratatoskr` | Key ID advertised alongside signed task submissions |
| `RATATOSKR_CONSOLIDATION_POLL_MS` | `120000` | Interval for polling Munin consolidation-worker health |
| `HEIMDALL_INGEST_URL` | — | Heimdall `/api/alerts` ingest URL. The `/api/send` → Heimdall echo runs only when **both** this and `HEIMDALL_ALERT_TOKEN` are set; either unset → echo skipped (issue #16). |
| `HEIMDALL_ALERT_TOKEN` | — | Bearer token for Heimdall's fail-closed alert ingest, sent on the echo. Required alongside `HEIMDALL_INGEST_URL` to enable the echo. |
| `RATATOSKR_CONCIERGE_RATE_LIMIT` | `8` | Max concierge (Haiku) triage calls per chat per window before messages are rate-limited (issue #3). |
| `RATATOSKR_CONCIERGE_RATE_WINDOW_MS` | `60000` | Sliding-window size for the concierge rate limit. |
| `RATATOSKR_TRANSCRIBE_URL` | — | Local OpenAI-compatible Whisper endpoint for voice messages (issue #1). Unset → voice messages politely declined; audio never leaves the box. |
| `RATATOSKR_TRANSCRIBE_MODEL` | `whisper-1` | Model name sent to the transcription endpoint. |
| `RATATOSKR_TRANSCRIBE_TOKEN` | — | Optional Bearer token if the local transcription endpoint is auth-gated. |
| `RATATOSKR_TRANSCRIBE_ALLOW_REMOTE` | `false` | Opt-in to a non-local transcription endpoint (suppresses the "audio off-box" startup warning). |
| `RATATOSKR_VOICE_MAX_DURATION_S` | `300` | Reject voice notes longer than this (seconds) before downloading/transcribing. |
| `RATATOSKR_DOCUMENTS_ENABLED` | `true` | Set `false` to disable document uploads. When enabled, document contents are sent to Anthropic for concierge reading. |
| `RATATOSKR_DOCUMENT_STORE` | `~/.local/state/ratatoskr/documents` | Private Pi-local attachment directory; Hugin tasks receive the stored path because they cannot access Telegram attachments. |
| `RATATOSKR_TRIAGE_URL` | — | M5 gateway `POST /delegate` endpoint for triage classification (issue #31), e.g. `http://<m5-tailnet-ip>:8080/delegate`. Unset → triage stays on the Anthropic path exactly as before (feature off). |
| `RATATOSKR_TRIAGE_MODEL` | `mellum` | Local model id pinned for M5 triage classification (pinned so the ledger's per-model dataset is controlled). Default `mellum` per issue #33 — beats `qwen3-30b-instruct` on accuracy (90% vs 84%), `ready` recall (88% vs 67%), and latency, with a smaller cold-swap window. |
| `RATATOSKR_TRIAGE_API_KEY` | — | Owner-tier Bearer token for the gateway's `/delegate` route (owner-tier-only; without it every call 401s and falls back — warned at boot). |
| `RATATOSKR_TRIAGE_TIMEOUT_MS` | `8000` | Bounded timeout for the M5 triage call; on expiry triage falls back to Anthropic (visible via log line + `m5_triage_fallbacks` metric). |
| `RATATOSKR_TRIAGE_ALLOW_REMOTE` | `false` | Opt-in to a non-local triage endpoint (suppresses the "message content off-box" startup warning). |

## Concierge design

The concierge is a lightweight Claude Haiku call (~2000 tokens, ~$0.001/call) that triages incoming Telegram messages before submitting Hugin tasks. It receives:
- The user's message
- Recent Munin context (last 5 log entries from active projects, current task queue)
- Conversation history (if in a clarification loop)

It returns one of three actions:
- `ready` — intent is clear, here's the enriched task prompt, context, and timeout
- `clarify` — ambiguous, here's a question to ask the user
- `answer` — can be answered directly from context, no task needed

Tone is defined by `RATATOSKR_SOUL` in `src/soul.ts` — casual, terse, warm, plain text only.

### M5 triage routing (issue #31)

When `RATATOSKR_TRIAGE_URL` is set, text-only triage classification is sent to the M5 gateway's `POST /delegate` (owner-tier) instead of the Anthropic SDK. The gateway runs the pinned local model (`RATATOSKR_TRIAGE_MODEL`), grades the output with a `matches` verifier on the `action` field, and records the attempt in its **capability ledger** (`GET /ledger`) — making triage the first production workload feeding Pillar 2. Semantics:

- **Never drop a message:** any gateway failure (timeout after `RATATOSKR_TRIAGE_TIMEOUT_MS`, non-2xx, policy block, unusable/unparseable output) falls back to the existing Anthropic path.
- **Strict parse on the local lane:** M5 output must be a fully valid triage decision; the lenient `{reply}`-rescue only applies to the Anthropic path (preserves historical behavior).
- **Fallbacks are visible:** a `console.warn` line + the `m5_triage_fallbacks` counter in `/heimdall.json` (plus `triage_m5_served` for the healthy path).
- **Evidence captures the backend:** each Munin `ratatoskr/triage` entry includes `backend`, `fallback`, and an `attempts[]` array (per-attempt routing outcomes in the ledger's vocabulary), tagged `backend:<x>` / `fallback:m5`.
- **Images and result summarization stay on Anthropic** — this is triage classification only.

### Result formatting pipeline

When a Hugin task completes, the result goes through:
1. **Extract** — `extractResultBody()` pulls content from under `### Response`, strips Hugin metadata (exit code, timestamps, cost, etc.)
2. **Strip** — `stripMarkdown()` converts markdown to plain text
3. **Summarize** — `summarizeResult()` sends the body through Haiku with the soul prompt for a terse 2-3 sentence summary (~$0.001/call)
4. **Fallback** — if summarization fails, uses the stripped body as-is
5. **Truncate** — `truncateForTelegram()` fits to Telegram's 4096 char limit
