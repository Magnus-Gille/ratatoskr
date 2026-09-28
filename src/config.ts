import path from "node:path";

/** Parse an env var as a positive integer, falling back to `fallback` if it is
 *  missing, non-numeric, or ≤ 0. Keeps the runtime safe from a mistyped value. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when the env var was set to a value that is NOT a positive integer. */
function isInvalidPositiveInt(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false; // unset → use default, fine
  const n = parseInt(raw, 10);
  return !Number.isFinite(n) || n <= 0;
}

const DEFAULT_ALLOWED_REPOS = [
  "munin-memory",
  "hugin",
  "heimdall",
  "ratatoskr",
  "skuld",
  "mimir",
  "fortnox-mcp",
  "grimnir",
  "verdandi",
  "brokkr",
];

function repoListEnv(raw: string | undefined): string[] {
  const value = raw && raw.trim() ? raw : DEFAULT_ALLOWED_REPOS.join(",");
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  llmProvider: process.env.LLM_PROVIDER || "anthropic",
  llmBaseUrl: process.env.LLM_BASE_URL || "",
  llmApiKey: process.env.LLM_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "",
  llmFallbackBaseUrl: process.env.LLM_FALLBACK_BASE_URL || "",
  llmFallbackApiKey: process.env.LLM_FALLBACK_API_KEY || "",
  llmFallbackModel: process.env.LLM_FALLBACK_MODEL || "",
  llmPrimaryTimeoutMs: positiveIntEnv(process.env.LLM_PRIMARY_TIMEOUT_MS, 20000),
  llmPrimaryTimeoutMsExplicit:
    process.env.LLM_PRIMARY_TIMEOUT_MS !== undefined &&
    process.env.LLM_PRIMARY_TIMEOUT_MS !== "" &&
    !isInvalidPositiveInt(process.env.LLM_PRIMARY_TIMEOUT_MS),
  llmFallbackTimeoutMs: positiveIntEnv(
    process.env.LLM_FALLBACK_TIMEOUT_MS,
    60000
  ),
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000"),
  maxPollDurationMs: parseInt(process.env.MAX_POLL_DURATION_MS || "7200000"),
  instanceId: process.env.RATATOSKR_INSTANCE_ID || "default",
  reposBasePath: process.env.REPOS_BASE_PATH || "/home/magnus/repos",
  allowedRepos: repoListEnv(process.env.RATATOSKR_ALLOWED_REPOS),
  sendApiKey: process.env.RATATOSKR_SEND_API_KEY || "",
  reminderStorePath:
    process.env.RATATOSKR_REMINDER_STORE ||
    path.join(
      process.env.HOME || "/home/magnus",
      ".local/state/ratatoskr/reminders.json"
    ),
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
  // Sanitized to positive ints so a mistyped env can't disable the limit (NaN →
  // allow-all) or the concierge (≤0 → reject-all); validateConfig warns on misuse.
  conciergeRateLimit: positiveIntEnv(
    process.env.RATATOSKR_CONCIERGE_RATE_LIMIT,
    8
  ),
  conciergeRateWindowMs: positiveIntEnv(
    process.env.RATATOSKR_CONCIERGE_RATE_WINDOW_MS,
    60000
  ),
  // Voice-message transcription (issue #1). Points at a local, OpenAI-compatible
  // Whisper endpoint (m5 / on-box) so audio never leaves Magnus's hardware. When
  // transcribeUrl is unset, voice messages are politely declined (no transcription).
  transcribeUrl: process.env.RATATOSKR_TRANSCRIBE_URL || "",
  transcribeModel: process.env.RATATOSKR_TRANSCRIBE_MODEL || "whisper-1",
  transcribeToken: process.env.RATATOSKR_TRANSCRIBE_TOKEN || "",
  // Acknowledge sending audio off-box (suppresses the non-local-endpoint warning).
  transcribeAllowRemote:
    (process.env.RATATOSKR_TRANSCRIBE_ALLOW_REMOTE || "").toLowerCase() ===
    "true",
  // Reject voice notes longer than this (seconds) before downloading/transcribing.
  voiceMaxDurationS: positiveIntEnv(
    process.env.RATATOSKR_VOICE_MAX_DURATION_S,
    300
  ),
  // Telegram documents are read by Anthropic's concierge, then persisted
  // locally so a downstream Hugin task can access the original attachment.
  documentsEnabled:
    (process.env.RATATOSKR_DOCUMENTS_ENABLED || "true").toLowerCase() !==
    "false",
  documentStorePath:
    process.env.RATATOSKR_DOCUMENT_STORE ||
    path.join(
      process.env.HOME || "/home/magnus",
      ".local/state/ratatoskr/documents"
    ),
  // M5 triage routing (issue #31). Points at the M5 gateway's POST /delegate
  // endpoint (e.g. http://<m5-tailnet-ip>:8080/delegate) so triage
  // classification runs on a local model and every attempt lands in the
  // gateway's capability ledger (Pillar 2). When triageUrl is unset the
  // concierge uses the Anthropic path exactly as before — feature OFF.
  triageUrl: process.env.RATATOSKR_TRIAGE_URL || "",
  triageModel: process.env.RATATOSKR_TRIAGE_MODEL || "mellum",
  triageApiKey: process.env.RATATOSKR_TRIAGE_API_KEY || "",
  // Bounded: a Pi→tailnet /delegate call must fail fast into the Anthropic
  // fallback rather than stall a Telegram reply (cold model swaps take longer
  // than this on purpose — a cold gateway degrades to fallback, visibly).
  triageTimeoutMs: positiveIntEnv(process.env.RATATOSKR_TRIAGE_TIMEOUT_MS, 8000),
  // Acknowledge sending triage message content off-box (suppresses the
  // non-local-endpoint warning), mirroring RATATOSKR_TRANSCRIBE_ALLOW_REMOTE.
  triageAllowRemote:
    (process.env.RATATOSKR_TRIAGE_ALLOW_REMOTE || "").toLowerCase() === "true",
};

/**
 * True when a URL's host is plausibly on the local box / private network — used
 * to back the "audio never leaves the box" privacy posture for transcription.
 * Covers loopback, bare hostnames (e.g. "m5"), .local/.internal, RFC1918 private
 * IPv4, and the Tailscale CGNAT range (100.64.0.0/10).
 */
export function isLocalHost(urlStr: string): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (!host.includes(".")) return true; // bare hostname like "m5", "huginmunin"
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64/10
    return false;
  }
  return false; // a public hostname/IP
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  return ipv4Parts(normalized)?.[0] === 127;
}

function isProtectedHttpHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (isLoopbackHostname(normalized)) return true;
  const parts = ipv4Parts(normalized);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Kept local so config validation has no dependency on the auth layer.
// Wildcard binds expose every interface.
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

export function validateConfig(): void {
  const required: { key: keyof typeof config; label: string }[] = [
    { key: "telegramBotToken", label: "TELEGRAM_BOT_TOKEN" },
    { key: "muninApiKey", label: "MUNIN_API_KEY" },
  ];

  if (![
    "anthropic",
    "openai-compatible",
  ].includes(config.llmProvider)) {
    console.error(
      "LLM_PROVIDER must be either anthropic or openai-compatible"
    );
    process.exit(1);
  }

  if (config.llmProvider === "anthropic") {
    required.push({ key: "anthropicApiKey", label: "ANTHROPIC_API_KEY" });
  } else {
    if (!config.llmBaseUrl) {
      required.push({ key: "llmBaseUrl", label: "LLM_BASE_URL" });
    }
    if (!config.llmModel) {
      required.push({ key: "llmModel", label: "LLM_MODEL" });
    }
  }

  const missing = required.filter((r) => !config[r.key]);
  if (missing.length > 0) {
    console.error(
      `Missing required env vars: ${missing.map((m) => m.label).join(", ")}`
    );
    process.exit(1);
  }

  if (config.llmProvider === "openai-compatible") {
    validateLlmUrl(config.llmBaseUrl, "LLM_BASE_URL");
    validateLlmCredentials(config.llmBaseUrl, config.llmApiKey, "LLM_API_KEY");
  }
  if (config.llmFallbackBaseUrl) {
    validateLlmUrl(config.llmFallbackBaseUrl, "LLM_FALLBACK_BASE_URL");
    validateLlmCredentials(
      config.llmFallbackBaseUrl,
      config.llmFallbackApiKey,
      "LLM_FALLBACK_API_KEY"
    );
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
  if (!isLoopbackHostname(config.host)) {
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

  // Concierge rate limit (issue #3). The runtime values are already sanitized to
  // safe positive ints (positiveIntEnv), but warn loudly when the operator set an
  // invalid value so the silent fall-back to defaults is visible at boot.
  if (
    isInvalidPositiveInt(process.env.RATATOSKR_CONCIERGE_RATE_LIMIT) ||
    isInvalidPositiveInt(process.env.RATATOSKR_CONCIERGE_RATE_WINDOW_MS)
  ) {
    console.warn(
      `⚠️  RATATOSKR_CONCIERGE_RATE_LIMIT / _WINDOW_MS is invalid (expected positive ` +
        `integers) — falling back to defaults ` +
        `(limit=${config.conciergeRateLimit}, windowMs=${config.conciergeRateWindowMs}).`
    );
  }

  // Voice transcription privacy posture (issue #1). The docs promise audio stays
  // on-box; warn loudly if the configured endpoint is NOT local, unless the
  // operator explicitly opts into remote transcription.
  if (
    config.transcribeUrl &&
    !config.transcribeAllowRemote &&
    !isLocalHost(config.transcribeUrl)
  ) {
    console.warn(
      `⚠️  RATATOSKR_TRANSCRIBE_URL (${config.transcribeUrl}) does not look local — ` +
        `voice audio would be sent OFF-BOX to it. Use a local Whisper endpoint, or set ` +
        `RATATOSKR_TRANSCRIBE_ALLOW_REMOTE=true to acknowledge sending audio remotely.`
    );
  }

  // M5 triage routing posture (issue #31) — same privacy stance as
  // transcription: triage message content must not silently leave the box.
  if (
    config.triageUrl &&
    !config.triageAllowRemote &&
    !isLocalHost(config.triageUrl)
  ) {
    console.warn(
      `⚠️  RATATOSKR_TRIAGE_URL (${config.triageUrl}) does not look local — ` +
        `triage message content would be sent OFF-BOX to it. Point it at the M5 ` +
        `gateway's tailnet address, or set RATATOSKR_TRIAGE_ALLOW_REMOTE=true to ` +
        `acknowledge sending message content remotely.`
    );
  }

  // The gateway's /delegate route is owner-tier-only; without a key every
  // triage call would 401 and fall back to Anthropic — permanently degraded,
  // so make the misconfig loud at boot instead of just a fallback counter.
  if (config.triageUrl && !config.triageApiKey) {
    console.warn(
      `⚠️  RATATOSKR_TRIAGE_URL is set but RATATOSKR_TRIAGE_API_KEY is empty — the M5 ` +
        `gateway's /delegate endpoint is owner-tier-only, so every triage call will fail ` +
        `and fall back to Anthropic until the key is set.`
    );
  }
}

function validateLlmUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`${label} must be a valid http(s) URL`);
    process.exit(1);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.error(`${label} must use http or https`);
    process.exit(1);
    return;
  }
  if (parsed.protocol === "http:" && !isProtectedHttpHostname(parsed.hostname)) {
    console.error(
      `${label} must use HTTPS for public endpoints; plain HTTP is allowed only ` +
        `for loopback, RFC1918 private, or Tailscale addresses`
    );
    process.exit(1);
  }
}

function validateLlmCredentials(
  url: string,
  apiKey: string,
  label: string
): void {
  let loopback = false;
  try {
    loopback = isLoopbackHostname(new URL(url).hostname);
  } catch {
    // URL syntax is validated separately; fail closed if this helper is called alone.
  }
  if (url && !loopback && !apiKey) {
    console.error(`${label} is required for a non-loopback LLM endpoint`);
    process.exit(1);
  }
}
