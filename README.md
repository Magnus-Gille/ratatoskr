# Ratatoskr

Telegram router and concierge for the [Grimnir](https://github.com/Magnus-Gille/grimnir)
personal AI infrastructure. Named for the squirrel who carries messages up and down
Yggdrasil.

Ratatoskr is the messaging edge of a self-hosted agent system: it receives Telegram
messages from allowlisted users, triages them with a small LLM, routes work to the
[Hugin](https://github.com/Magnus-Gille/hugin) task dispatcher via
[Munin](https://github.com/Magnus-Gille/munin-memory) memory writes, and delivers
alerts, reminders, and task results back to chat.

## What it does

- **Concierge triage** — incoming messages are classified by a small model
  (Claude Haiku by default, optionally an OpenAI-compatible endpoint or local M5
  gateway model) and either answered directly, turned into Hugin tasks, or politely
  declined. Per-chat rate limits bound API spend.
- **Reminders** — `POST /api/reminders` with idempotent scheduling and delivery
  receipts (`docs/reminders.md`).
- **Authenticated remote send** — trusted tailnet hosts can fire Telegram pings
  through `POST /api/send` with a Bearer token, without SSH access to the host
  (`docs/remote-send.md`).
- **Alert-bus echo** — alerts posted to `/api/send` are best-effort echoed to the
  [Heimdall](https://github.com/Magnus-Gille/heimdall) monitoring dashboard's
  fail-closed ingest.
- **Voice notes** — optional transcription through an OpenAI-compatible local Whisper
  endpoint; audio never leaves the box unless explicitly opted in.
- **Task result delivery** — polls Munin for completed Hugin tasks and delivers
  results to the originating chat.

## Security posture

- Telegram access is restricted to an explicit user allowlist.
- The HTTP API binds to loopback or a Tailscale address, never `0.0.0.0`; a
  non-loopback bind without an API key disables the send endpoint (fail closed).
- Bearer tokens are compared timing-safe; secrets live in an untracked `.env`.
- Remote (off-box) transcription and triage endpoints require explicit
  `ALLOW_REMOTE` opt-in.

## Running it

```bash
# Copy .env.example into an untracked local configuration source and fill in
# TELEGRAM_BOT_TOKEN, the allowlist, and the required keys.
npm ci
npm test
npm run build
node dist/index.js
```

The default concierge provider is Anthropic. To use an OpenAI-compatible endpoint,
set `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, and `LLM_MODEL`; see
`docs/environment.md` for fallback and timeout settings. Use placeholders for
endpoint URLs and credentials in shared configuration examples.

Production runs as a systemd service on a Raspberry Pi — see `ratatoskr.service`
and `scripts/deploy-pi.sh`. Component inventory (hosts, ports, units) lives in the
Grimnir registry.

## Development

- `npm test` — vitest suite
- `npm run build` — TypeScript build
- Agent guidance: `AGENTS.md` (canonical) with `CLAUDE.md` as an adapter

## License

[MIT](LICENSE)
