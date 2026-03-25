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
};

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
}
