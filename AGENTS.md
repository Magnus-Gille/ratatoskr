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

### Reference docs

Reference material lives under `docs/`; start with `docs/index.md`.

- `docs/architecture.md` — detailed source map for Express startup, Telegram
  handlers, concierge triage, Munin/Hugin task flow, reminders, alerts,
  transcription, document storage, recovery, and health/Heimdall surfaces.
- `docs/environment.md` — the full runtime configuration table for
  `TELEGRAM_*`, `MUNIN_*`, `CONCIERGE_MODEL`, `RATATOSKR_*`, and
  `HEIMDALL_*`.
- `docs/remote-send.md` — authenticated remote `/api/send` over Tailscale and
  the `scripts/ratatoskr send` operational path.
- `docs/reminders.md` — reminder API plus persistence, delivery, and crash
  semantics.
- `docs/alert-consumer-evidence-2026-07-26.md` — bounded production evidence
  for Heimdall firing/resolution receipt.

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

The deploy script records the exact source SHA in `.deployed-commit` only after
the restart/status check passes, so Heimdall/Grimnir can prove which revision is
live. Laptop/remote deploys refuse a dirty tree. The Pi target is an artifact
directory: remote deploys remove any `.git` file/directory and rsync never sends
Git metadata. In-place deploys therefore cannot infer source provenance and must use
`DEPLOY_COMMIT=<source-sha> ./scripts/deploy-pi.sh local`. The old marker is
removed before mutation; a failed mid-deploy is deliberately unmarked rather
than falsely claiming either revision.

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
`RATATOSKR_SEND_API_KEY`). The full runtime configuration table lives in
`docs/environment.md`.

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
