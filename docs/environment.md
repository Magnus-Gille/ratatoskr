# Ratatoskr environment variables

This is the full runtime configuration table for Ratatoskr. Operational setup
for remote send still lives in `remote-send.md`; the deployment safety contract
and the M5 fallback rules stay inline in `AGENTS.md`.

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
