# Durable scheduled reminders

Ratatoskr can accept a reminder while a caller is online, persist it on the Pi,
then deliver it locally even if the original laptop or tailnet path is offline at
the due time. All routes use the same Bearer token and chat allowlist as
`POST /api/send`.

On loopback with no `RATATOSKR_SEND_API_KEY`, local processes inherit the same
trusted-host write access as `/api/send`. Set the key even on loopback when the
Pi runs untrusted local workloads.

## Create

`deliver_at` must include `Z` or an explicit UTC offset, be in the future, and
be no more than one year away. Ratatoskr normalizes it to UTC. The required
`idempotency_key` is scoped to the destination chat and makes an ambiguous client retry safe: the same request returns
the existing reminder; reusing the key for different content returns `409`.

```bash
curl --fail --request POST "http://${HOST}:${PORT:-3034}/api/reminders" \
  --header "Authorization: Bearer $RATATOSKR_SEND_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "chat_id": 123456789,
    "text": "Check the M5 BIOS",
    "deliver_at": "2026-07-13T06:00:00Z",
    "idempotency_key": "m5-bios-2026-07-13"
  }'
```

A new reminder returns `202` with `accepted:true`, `persisted:true`, `sent:false`,
and a stable reminder id. An identical retry returns `200` and
`deduplicated:true`.

## List, status, cancel

```bash
curl --header "Authorization: Bearer $RATATOSKR_SEND_API_KEY" \
  "http://${HOST}:${PORT:-3034}/api/reminders?status=pending"
curl --header "Authorization: Bearer $RATATOSKR_SEND_API_KEY" \
  "http://${HOST}:${PORT:-3034}/api/reminders/<id>"
curl --request DELETE --header "Authorization: Bearer $RATATOSKR_SEND_API_KEY" \
  "http://${HOST}:${PORT:-3034}/api/reminders/<id>"
```

List and status responses intentionally omit reminder text. Only `pending`
reminders can be cancelled.

## Delivery and crash semantics

Delivery uses **at-most-once attempt** semantics because Telegram's Bot API has
no idempotency key. Ratatoskr durably changes a due reminder from `pending` to
`sending` before calling Telegram. A crash in that narrow window leaves the
delivery outcome unknowable, so startup marks it `failed` and does not retry;
this prevents a silent duplicate. Ordinary Telegram errors also become
`failed` and are not retried. A 30-second delivery timeout is recorded as
`delivery_timeout_outcome_unknown` because the remote outcome cannot be proven.
Callers can inspect status and deliberately create
a new reminder with a new idempotency key if another attempt is wanted.

The default store is `~/.local/state/ratatoskr/reminders.json`, outside the
rsynced repository, so both service restarts and deployments preserve it.
Writes fsync the new file before atomic rename, then fsync the directory. Terminal
history and its idempotency keys are retained for 90 days; at most 1000 reminders
may be pending at once. Corrupt stores are quarantined instead of crash-looping
the Telegram bot, and pending/failed counts are exposed without message text in
`/health` and `/heimdall.json`.
