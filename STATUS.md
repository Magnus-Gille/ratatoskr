# Ratatoskr Status

**Last session:** 2026-03-28
**Branch:** main

## Completed This Session
- `5aff38c` fix: inject working directory into repo tasks
  - `resolveWorkingDirectory()` maps `repo:<name>` → `/home/magnus/repos/<name>`
  - `REPOS_BASE_PATH` env var (default `/home/magnus/repos`) added to config
- `38444e0` fix: guard against undefined messages in conversation state
  - `deleteConversation` was writing `"{}"` to Munin; loading it back gave `messages: undefined`, crashing `triage()` on `.map()`
  - Fixed in both `getConversation` (guard) and `deleteConversation` (write valid state)
- Cloned `gille-ai` to Pi at `/home/magnus/repos/gille-ai`
- Added `grimnir-bot` as collaborator to `Magnus-Gille/gille-ai` (push access)

## Completed Previously
- Poll recovery, delivery confirmation, conversation persistence (`659a1ab`)
- POST /api/send endpoint for outbound Telegram messages (`ae4f64a`)
- Full Ratatoskr implementation: bot, concierge, task submission, result polling (`bd28ebc`)
- Deployed on Pi (huginmunin), systemd service, Heimdall monitoring

## In Progress
- Nothing — all fixes deployed

## Next Steps
- For each new private repo Hugin needs to touch: add `grimnir-bot` as collaborator + clone on Pi
- Consider adding photo/voice/document handling (currently silently ignored)
- Consider "task picked up" intermediate notifications
- Consider rate limiting / debounce on concierge calls
