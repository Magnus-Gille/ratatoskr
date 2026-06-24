export const config = {
  port: parseInt(process.env.PORT || "3034"),
  host: process.env.HOST || "127.0.0.1",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  conciergeModel: process.env.CONCIERGE_MODEL || "claude-haiku-4-5-20251001",
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000"),
  maxPollDurationMs: parseInt(process.env.MAX_POLL_DURATION_MS || "7200000"),
  instanceId: process.env.RATATOSKR_INSTANCE_ID || "default",
  reposBasePath: process.env.REPOS_BASE_PATH || "/home/magnus/repos",
  sendApiKey: process.env.RATATOSKR_SEND_API_KEY || "",
  signingSecret: process.env.RATATOSKR_SIGNING_SECRET || "",
  signingKeyId: process.env.RATATOSKR_SIGNING_KEY_ID || "ratatoskr",
  consolidationPollMs: parseInt(
    process.env.RATATOSKR_CONSOLIDATION_POLL_MS || "120000"
  ),
  // Heimdall alert-bus echo (issue #16). When heimdallIngestUrl is unset the
  // POST /api/send → Heimdall echo is skipped; the Telegram send is unaffected.
  heimdallIngestUrl: process.env.HEIMDALL_INGEST_URL || "",
  heimdallAlertToken: process.env.HEIMDALL_ALERT_TOKEN || "",
  // Per-user concierge (Haiku) rate limit (issue #3): at most N triage calls per
  // window per chat, so a burst of messages can't fan out into unbounded API calls.
  conciergeRateLimit: parseInt(
    process.env.RATATOSKR_CONCIERGE_RATE_LIMIT || "8"
  ),
  conciergeRateWindowMs: parseInt(
    process.env.RATATOSKR_CONCIERGE_RATE_WINDOW_MS || "60000"
  ),
};

// Mirrors LOOPBACK_HOSTS in auth.ts — kept local so config validation has no
// dependency on the auth layer. Wildcard binds expose every interface.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

export function validateConfig(): void {
  const required: { key: keyof typeof config; label: string }[] = [
    { key: "telegramBotToken", label: "TELEGRAM_BOT_TOKEN" },
    { key: "anthropicApiKey", label: "ANTHROPIC_API_KEY" },
    { key: "muninApiKey", label: "MUNIN_API_KEY" },
  ];

  const missing = required.filter((r) => !config[r.key]);
  if (missing.length > 0) {
    console.error(
      `Missing required env vars: ${missing.map((m) => m.label).join(", ")}`
    );
    process.exit(1);
  }

  if (config.allowedUsers.length === 0) {
    console.error(
      "TELEGRAM_ALLOWED_USERS must contain at least one user ID"
    );
    process.exit(1);
  }

  // Remote-send posture (see docs/remote-send.md). Non-fatal — the bot must keep
  // serving Telegram even when /api/send is fail-closed, and a misconfig here
  // should be loud at boot rather than surface only as a runtime 401.
  if (!LOOPBACK_HOSTS.has(config.host)) {
    if (!config.sendApiKey) {
      console.warn(
        `⚠️  HOST=${config.host} is non-loopback but RATATOSKR_SEND_API_KEY is unset — ` +
          `POST /api/send is DISABLED (fail-closed). Set the key to enable authenticated remote send.`
      );
    }
    if (WILDCARD_HOSTS.has(config.host)) {
      console.warn(
        `⚠️  HOST=${config.host} is a wildcard bind — /api/send is exposed on ALL interfaces ` +
          `incl. LAN/Wi-Fi, where the Bearer token is NOT transport-encrypted. Bind to this ` +
          `Pi's Tailscale IP instead (see docs/remote-send.md).`
      );
    }
  }

  // Heimdall alert-echo posture (issue #16). The echo runs only when BOTH the URL
  // and the token are set; a URL without a token would POST an unauthenticated
  // `Bearer ` that Heimdall's fail-closed ingest rejects (401), silently dropping
  // every echoed alert. Warn loudly rather than degrade silently.
  if (config.heimdallIngestUrl && !config.heimdallAlertToken) {
    console.warn(
      `⚠️  HEIMDALL_INGEST_URL is set but HEIMDALL_ALERT_TOKEN is empty — the ` +
        `/api/send → Heimdall alert echo is DISABLED until the token is set ` +
        `(Heimdall's ingest is fail-closed and would reject an unauthenticated POST).`
    );
  }

  // Concierge rate limit (issue #3). A non-positive / non-numeric limit or window
  // would make the limiter reject every message (limit ≤ 0) or never limit at all
  // (NaN) — both are footguns, so flag a misconfig loudly (non-fatal).
  if (
    !Number.isFinite(config.conciergeRateLimit) ||
    config.conciergeRateLimit <= 0 ||
    !Number.isFinite(config.conciergeRateWindowMs) ||
    config.conciergeRateWindowMs <= 0
  ) {
    console.warn(
      `⚠️  RATATOSKR_CONCIERGE_RATE_LIMIT / _WINDOW_MS is misconfigured ` +
        `(limit=${config.conciergeRateLimit}, windowMs=${config.conciergeRateWindowMs}) — ` +
        `expected positive integers. The concierge rate limit may not behave as intended.`
    );
  }
}
