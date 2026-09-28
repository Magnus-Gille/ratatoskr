# Ratatoskr architecture

## Runtime

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Framework:** Express (health endpoint only) + grammy (Telegram bot)
- **AI:** Anthropic by default, with an optional OpenAI-compatible concierge provider
  and configured fallback; summarization uses the same adapter
- **Deployment:** systemd on a private deployment host, port `3034`
- **Telegram mode:** long-polling only; no inbound webhook

## Request flow

1. Telegram message arrives from an allowlisted user.
2. Concierge triage combines the message with Munin context and chooses
   `ready`, `clarify`, or `answer`.
3. Ready tasks are formatted for Hugin and written to Munin.
4. Result polling watches the task state and sends the final reply back to
   Telegram.

## Source map

- `src/index.ts` — Express app (health endpoint + registers `/api/send` route)
  + bot startup + poll recovery
- `src/bot.ts` — Telegram bot setup, message/photo/voice/document handlers,
  allowlist, conversation persistence; shared `handleTriageResult` drives
  submit/clarify/answer for all input types, and fire-and-forget logs each
  triage decision to Munin (`ratatoskr/triage`) + records it in `TriageStats`
  (issue #27)
- `src/llm-adapter.ts` — provider-neutral request/response adapter for Anthropic
  and OpenAI-compatible chat-completions endpoints, including tool-call translation
- `src/concierge.ts` — intent triage (multimodal: text + images) + result
  summarization. Text triage classification routes through the M5 gateway's
  `POST /delegate` when `RATATOSKR_TRIAGE_URL` is set (issue #31) — the gateway
  records each attempt in the Pillar-2 capability ledger — with graceful,
  visible fallback to the Anthropic Haiku path on any gateway error/timeout;
  image triage and summarization stay on Anthropic. `triage()` returns a
  `meta` field (serving backend, model, fallback flag, per-attempt routing
  outcomes, latency, tokens) alongside the action (issues #27/#31)
- `src/triage-stats.ts` — `TriageStats`: in-memory (process-lifetime) tally of
  triage decisions by action + serving backend + M5 fallbacks + avg
  latency/tokens, read by `/heimdall.json` for real competence metrics
  (issues #27/#31)
- `src/soul.ts` — `RATATOSKR_SOUL` constant defining Ratatoskr's
  voice/personality for all Telegram output
- `src/task-writer.ts` — format task markdown, write to Munin (with instance
  tag)
- `src/result-poller.ts` — poll Munin for task results, delivery confirmation;
  fires a one-time "picked up" ack on the first `running` transition (issue
  #2), de-duped via a persisted Munin marker so a restart doesn't re-announce
- `src/recovery.ts` — startup recovery: reattach polls, deliver undelivered
  results
- `src/munin-client.ts` — HTTP client for Munin JSON-RPC API
- `src/descriptor.ts` — `buildHeimdallDescriptor(state)`: builds the
  `/heimdall.json` body with `status`/`metrics` computed from live state (bot
  connection, active polls, triage stats) rather than hardcoded (issue #27)
- `src/telegram-util.ts` — result formatting: metadata extraction, markdown
  stripping, summarization pipeline, truncation
- `src/telegram-file.ts` — download media from Telegram's file API:
  `downloadPhoto` (base64 image) + `downloadFile` (raw bytes for voice/audio,
  issue #1)
- `src/transcribe.ts` — `createTranscriber`: posts audio to a local
  OpenAI-compatible `/v1/audio/transcriptions` Whisper endpoint (config-gated,
  audio stays on-box) and returns the transcript (issue #1)
- `src/document.ts` — validates PDF/text document type and size, converts
  Telegram downloads into bounded Anthropic document blocks, and rejects
  invalid UTF-8 (issue #1)
- `src/document-store.ts` — persists original Telegram document bytes under a
  private Pi-local path that downstream Hugin tasks can read; cleans non-task
  files and prunes ready-task attachments after 30 days (issue #1)
- `src/message-tracker.ts` — in-memory tracker mapping outbound Telegram
  message IDs to context (for reply awareness)
- `src/message-aggregator.ts` — debounce rapid Telegram message fragments into
  single logical messages
- `src/rate-limiter.ts` — `SlidingWindowRateLimiter`: per-key sliding-window
  limiter (pure, time-injectable). Caps concierge/Haiku triage calls per chat
  so a message burst can't fan out into unbounded API calls (issue #3)
- `src/auth.ts` — bearer-token middleware for `POST /api/send` (timing-safe;
  fail-closed when bound non-loopback without a key)
- `src/send-handler.ts` — `POST /api/send` route: `createSendHandler` (pure,
  DI'd handler — validation → allowlist → send → Heimdall lifecycle
  forwarding) + `registerSendRoute` (wires auth → `express.json()` → handler in
  order). Extracted from `index.ts` as the testable seam (tested in
  `tests/send-handler.test.ts`). Accepts `{chat_id, text}` and/or `{chat_id,
  alert}`; firing/text-backed echoes are best-effort, while resolution-only
  envelopes traverse auth/allowlisting and require successful Heimdall delivery
  without Telegram rendering (issue #16)
- `src/reminders.ts` — fsynced/atomic Pi-local reminder store and bounded
  delivery scheduler with restart quarantine, 90-day terminal retention,
  idempotency, and at-most-once attempt semantics; `src/reminder-handler.ts`
  exposes authenticated create/list/status/cancel routes (issue #40)
- `src/alert.ts` — alert-bus support for `/api/send` (issue #16):
  discriminated firing/resolved `AlertEnvelope` types, `validateAlert` (firing
  requires title; resolution requires nonempty `dedup_key`; rebuilds a clean
  allowlisted envelope), `renderAlertText` (severity header + body + links,
  self-bounded to Telegram's 4096 limit), `createHeimdallNotifier` (POSTs the
  envelope to Heimdall's `/api/alerts` ingest and surfaces delivery failures to
  the route's lifecycle policy)
- `src/consolidation-health-poller.ts` — poll Munin consolidation-worker
  health; Telegram alert on failure/recovery
- `src/listen.ts` — resilient HTTP listener bind: retry `EADDRNOTAVAIL`
  (Tailscale IP not yet assigned) instead of crash-looping the process
- `src/config.ts` — environment configuration
