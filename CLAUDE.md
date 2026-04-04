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

- `src/index.ts` — Express health endpoint + bot startup + poll recovery
- `src/bot.ts` — Telegram bot setup, message/photo handlers, allowlist, conversation persistence
- `src/concierge.ts` — Intent triage via Claude Haiku API (multimodal: text + images), result summarization
- `src/soul.ts` — `RATATOSKR_SOUL` constant defining Ratatoskr's voice/personality for all Telegram output
- `src/task-writer.ts` — Format task markdown, write to Munin (with instance tag)
- `src/result-poller.ts` — Poll Munin for task results, delivery confirmation
- `src/recovery.ts` — Startup recovery: reattach polls, deliver undelivered results
- `src/munin-client.ts` — HTTP client for Munin JSON-RPC API
- `src/telegram-util.ts` — Result formatting: metadata extraction, markdown stripping, summarization pipeline, truncation
- `src/telegram-file.ts` — Download photos from Telegram's file API
- `src/message-tracker.ts` — In-memory tracker mapping outbound Telegram message IDs to context (for reply awareness)
- `src/message-aggregator.ts` — Debounce rapid Telegram message fragments into single logical messages
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

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3034` | Health endpoint port |
| `HOST` | `127.0.0.1` | Bind address |
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
