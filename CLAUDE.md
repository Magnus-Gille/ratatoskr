# Ratatoskr — CLAUDE.md

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
- `src/bot.ts` — Telegram bot setup, message/photo handlers, allowlist, conversation persistence
- `src/concierge.ts` — Intent triage via Claude Haiku API (multimodal: text + images), result summarization
- `src/soul.ts` — `RATATOSKR_SOUL` constant defining Ratatoskr's voice/personality for all Telegram output
- `src/task-writer.ts` — Format task markdown, write to Munin (with instance tag)
- `src/result-poller.ts` — Poll Munin for task results, delivery confirmation; fires a one-time "picked up" ack on the first `running` transition (issue #2), de-duped via a persisted Munin marker so a restart doesn't re-announce
- `src/recovery.ts` — Startup recovery: reattach polls, deliver undelivered results
- `src/munin-client.ts` — HTTP client for Munin JSON-RPC API
- `src/telegram-util.ts` — Result formatting: metadata extraction, markdown stripping, summarization pipeline, truncation
- `src/telegram-file.ts` — Download photos from Telegram's file API
- `src/message-tracker.ts` — In-memory tracker mapping outbound Telegram message IDs to context (for reply awareness)
- `src/message-aggregator.ts` — Debounce rapid Telegram message fragments into single logical messages
- `src/auth.ts` — Bearer-token middleware for `POST /api/send` (timing-safe; fail-closed when bound non-loopback without a key)
- `src/send-handler.ts` — `POST /api/send` route: `createSendHandler` (pure, DI'd handler — validation → allowlist → send → best-effort Heimdall echo) + `registerSendRoute` (wires auth → `express.json()` → handler in order). Extracted from `index.ts` as the testable seam (tested in `tests/send-handler.test.ts`). Accepts `{chat_id, text}` and/or `{chat_id, alert}` (issue #16)
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
| `RATATOSKR_SEND_API_KEY` | — | Bearer token for `POST /api/send`. Mandatory when `HOST` is non-loopback (the endpoint is disabled otherwise); when set, enforced on **all** binds incl. loopback. See `docs/remote-send.md`. |
| `RATATOSKR_SIGNING_SECRET` | — | HMAC-SHA256 secret for Hugin task submission signing (PR #5) |
| `RATATOSKR_SIGNING_KEY_ID` | `ratatoskr` | Key ID advertised alongside signed task submissions |
| `RATATOSKR_CONSOLIDATION_POLL_MS` | `120000` | Interval for polling Munin consolidation-worker health |
| `HEIMDALL_INGEST_URL` | — | Heimdall `/api/alerts` ingest URL. The `/api/send` → Heimdall echo runs only when **both** this and `HEIMDALL_ALERT_TOKEN` are set; either unset → echo skipped (issue #16). |
| `HEIMDALL_ALERT_TOKEN` | — | Bearer token for Heimdall's fail-closed alert ingest, sent on the echo. Required alongside `HEIMDALL_INGEST_URL` to enable the echo. |

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

### Result formatting pipeline

When a Hugin task completes, the result goes through:
1. **Extract** — `extractResultBody()` pulls content from under `### Response`, strips Hugin metadata (exit code, timestamps, cost, etc.)
2. **Strip** — `stripMarkdown()` converts markdown to plain text
3. **Summarize** — `summarizeResult()` sends the body through Haiku with the soul prompt for a terse 2-3 sentence summary (~$0.001/call)
4. **Fallback** — if summarization fails, uses the stripped body as-is
5. **Truncate** — `truncateForTelegram()` fits to Telegram's 4096 char limit
