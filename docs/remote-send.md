# Authenticated remote send over Tailscale

Lets any **trusted tailnet host** (e.g. Magnus's laptop) fire a Telegram ping
through Ratatoskr **without SSH to the Pi and without the YubiKey** — closing the
gap where a Telegram alert could only be triggered from the Pi itself.

## How it works

`POST /api/send` already enforces a Bearer token (PR #7, `src/auth.ts`):

| `RATATOSKR_SEND_API_KEY` | Bind | Behaviour |
|---|---|---|
| unset | loopback (`127.0.0.1`/`::1`) | open (on-box trust only) |
| unset | non-loopback | **disabled** → `401` (fail-closed) |
| set | any bind | Bearer token enforced (timing-safe), incl. loopback |

So no code change is needed to *expose* the endpoint — only configuration. We
bind the listener to the Pi's **Tailscale IP** (not `0.0.0.0`) so the socket is
reachable only by tailnet peers, and set a key so every request is authenticated.

**Why the Tailscale IP and not `0.0.0.0`?** The server speaks plain HTTP — fine
over Tailscale because WireGuard already encrypts the transport, so the Bearer
token is never exposed on the wire. A `0.0.0.0` bind would also expose
plain-HTTP-plus-token on the Pi's LAN/Wi-Fi, where it is *not* encrypted. Binding
to the tailnet IP keeps the token on the encrypted tailnet only.

> **Heads-up — availability coupling.** Binding the process to the Tailscale IP
> means the listener can only start once `tailscaled` has assigned the address.
> The listener handles this in-process: `src/listen.ts` retries an
> `EADDRNOTAVAIL` bind (≈60×, 5s apart) instead of letting the unhandled `error`
> event crash-loop the whole process — so a boot race or a runtime tailnet blip
> no longer takes the Telegram bot (which needs no tailnet) down with it.
> `After=tailscaled.service` still orders the common case, and `Restart=always`
> is the backstop once the retry cap is exhausted. See **Bind resilience** below.

---

## Deploy order (cross-repo — do this sequence)

The grimnir `notify.sh` change and this ratatoskr change are coupled: once
`notify.sh` defaults to the tailnet URL + Bearer key, it only works against a Pi
that is already reconfigured. Deploy in this order so no window sends to a
dead/unauthenticated endpoint:

1. **Pi first** — set `HOST`+key, install the new unit, restart (steps below),
   then run the on-Pi verify. Until the key is set, `/api/send` is fail-closed
   (the service logs a `⚠️ … fail-closed` warning at boot — see `validateConfig`).
2. **Then the laptop** — create `~/.config/grimnir/notify.env` and verify a live
   round-trip.
3. Land both PRs (ratatoskr `feat/remote-send-tailscale` + the grimnir branch)
   before or alongside the deploy; don't run off uncommitted working trees.

## Enable it (run on the Pi — needs YubiKey/SSH)

```bash
# 1. Generate a strong key (keep this — you'll provision it to the laptop too)
KEY=$(openssl rand -hex 32); echo "$KEY"

# 2. Find this Pi's Tailscale IP
TS_IP=$(tailscale ip -4); echo "$TS_IP"      # e.g. 100.100.100.100

# 3. Set both in the Pi's .env (NOT committed; deploy-pi.sh excludes it)
cd ~/repos/ratatoskr
sed -i "s|^HOST=.*|HOST=${TS_IP}|"                  .env
sed -i "s|^RATATOSKR_SEND_API_KEY=.*|RATATOSKR_SEND_API_KEY=${KEY}|" .env
grep -E '^(HOST|RATATOSKR_SEND_API_KEY)=' .env      # confirm

# 4. Pick up the new ratatoskr.service (After=tailscaled) + restart
sudo cp ratatoskr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart ratatoskr
systemctl status ratatoskr --no-pager | head -5
```

`./scripts/deploy-pi.sh` from the laptop does the build/rsync + unit install
(step 4 only); the `.env` edits (steps 1–3) must be done on the Pi by hand
because `.env` is intentionally excluded from the rsync. `deploy-pi.sh` never
generates or touches the key.

### Verify on the Pi

```bash
CHAT_ID=<your-telegram-user-id>      # set this first — it must be a bare number
curl -s http://$TS_IP:3034/health | head -c 200; echo
# Authed send:
curl -s -X POST http://$TS_IP:3034/api/send \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"chat_id\": ${CHAT_ID}, \"text\": \"ratatoskr remote-send live ✅\"}"
# Negative control — no key must now 401 (loopback included):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://$TS_IP:3034/api/send \
  -H 'Content-Type: application/json' -d '{"chat_id":0,"text":"x"}'   # → 401
```

---

## Provision a trusted host (the laptop — no Pi `.env` exists here)

`grimnir`'s `scripts/lib/notify.sh` reads creds from a small fleet secrets file
when no Ratatoskr `.env` is present. Create it (mode `600`):

```bash
mkdir -p ~/.config/grimnir
cat > ~/.config/grimnir/notify.env <<EOF
RATATOSKR_URL=http://huginmunin:3034/api/send
RATATOSKR_SEND_API_KEY=<the KEY from step 1>
TELEGRAM_ALLOWED_USERS=<your Telegram user id>
EOF
chmod 600 ~/.config/grimnir/notify.env
```

`huginmunin` resolves to the Pi's Tailscale IP via MagicDNS. If MagicDNS is off,
use the full `huginmunin.<tailnet>.ts.net` name or the raw `100.x.y.z` IP.

### Verify from the laptop

```bash
source ~/repos/grimnir/scripts/lib/notify.sh
notify_telegram "ping from laptop over tailnet 🐿️"
```

---

## Send from the Pi even when the service is stopped

The deployed helper reads the trusted project `.env` and calls Telegram's Bot
API directly, so it does not depend on the long-poll bot or HTTP listener being
up:

```bash
cd /home/magnus/repos/ratatoskr
./scripts/ratatoskr send "unattended job finished"
```

It sends to the first `TELEGRAM_ALLOWED_USERS` entry by default. Set
`RATATOSKR_CHAT_ID` in `.env` when a different allowlisted destination should be
the operational default; an ambient `RATATOSKR_CHAT_ID` overrides the file for a
one-off destination. The helper reads only those three scalar values from
the systemd-compatible env file; it does not source or export the other secrets.
The bot-token URL is passed to curl over stdin, keeping the token out of output,
the process table, and curl's inherited environment. Successful Telegram
response bodies are suppressed; safe error descriptions are shown.

For an authenticated HTTP call from the Pi, use the configured bind address —
the production service is tailnet-bound, so a hardcoded loopback URL is stale:

```bash
(
  set -a; source /home/magnus/repos/ratatoskr/.env; set +a
  curl --fail --silent --show-error \
    --request POST "http://${HOST:-127.0.0.1}:${PORT:-3034}/api/send" \
    --header "Authorization: Bearer $RATATOSKR_SEND_API_KEY" \
    --header 'Content-Type: application/json' \
    --data "{\"chat_id\":${TELEGRAM_ALLOWED_USERS%%,*},\"text\":\"service is live\"}"
)
```

If Telegram is unavailable, the non-interactive email fallback is Himalaya. It
needs an explicit sender because the account does not inject one automatically:

```bash
printf 'From: magnus@gille.ai\nTo: <recipient>\nSubject: Ratatoskr fallback\n\n%s\n' \
  "unattended job finished" | himalaya -a gille message send
```

---

## Bind resilience (decouples the bot from the tailnet)

So a tailnet outage can't crash-loop the whole process when the Tailscale IP is
unavailable, the listener carries a bind-retry `error` handler —
`attachBindResilience()` in `src/listen.ts`, wired into `src/index.ts` right after
`app.listen`. Instead of letting the unhandled `error` event kill the process, it
re-binds on `EADDRNOTAVAIL`:

```ts
const server = app.listen(config.port, config.host, () => { /* ...existing log... */ });
attachBindResilience(server, config.host, config.port);
```

It retries the bind on `EADDRNOTAVAIL` up to `MAX_BIND_RETRIES` (60, ≈5 min at
`BIND_RETRY_DELAY_MS` = 5s), then exits so `Restart=always` takes over rather than
spinning forever; the re-`listen` is called directly (the failed socket never
bound, so there's nothing to `close()` first). Only `EADDRNOTAVAIL` is retried —
any other bind error (e.g. `EADDRINUSE` from a duplicate process) is fatal
immediately, so a real misconfiguration surfaces instead of being masked. The
decision logic lives in the pure `decideBindRetry()` and is covered by
`tests/listen.test.ts`.

While the bind is unavailable the health + `/api/send` endpoint is down, but the
Telegram bot keeps polling — the point of decoupling them.

---

## Operating notes

- **Key charset:** generate with `openssl rand -hex 32` (or base64url). Keep it
  free of quotes, spaces, and backslashes — `notify.sh` interpolates it into a
  `curl --config` line, so an exotic key could break parsing.
- **Rotation:** regenerate the key, update the Pi `.env` + every `notify.env`,
  then `systemctl restart ratatoskr`. The old key stops working the instant the
  service restarts.
- **Never use a wildcard bind:** `HOST=0.0.0.0`/`::` serves `/api/send` on the
  LAN/Wi-Fi too, where plain HTTP + the Bearer token are **not** encrypted. The
  transport-encryption argument holds only for the Tailscale IP. `validateConfig`
  warns loudly at boot if you do this, but it is not hard-blocked.
- **Allowed-users gate still applies:** even an authenticated caller can only send
  to a `chat_id` in `TELEGRAM_ALLOWED_USERS` (`src/index.ts`), so a leaked key
  can't spam arbitrary chats.
- **Reverting to loopback-only:** set `HOST=127.0.0.1` and clear
  `RATATOSKR_SEND_API_KEY`, then restart. Also reset any `RATATOSKR_URL` you set
  for `notify.sh` back to `http://127.0.0.1:3034/api/send` (or unset it) — leaving
  it pointed at `huginmunin` after reverting the bind breaks on-box alerts.
