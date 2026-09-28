import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config validation", () => {
  const originalEnv = process.env;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;
  let mockWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    mockExit.mockRestore();
    mockError.mockRestore();
    mockWarn.mockRestore();
  });

  it("should exit if TELEGRAM_BOT_TOKEN is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    delete process.env.TELEGRAM_BOT_TOKEN;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("TELEGRAM_BOT_TOKEN")
    );
  });

  it("loads the OpenAI-compatible provider settings", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_BASE_URL = "http://localhost:1234/v1";
    process.env.LLM_MODEL = "local-model";
    delete process.env.ANTHROPIC_API_KEY;

    const { config: loadedConfig, validateConfig } = await import("../src/config.js");
    validateConfig();

    expect(loadedConfig.llmProvider).toBe("openai-compatible");
    expect(loadedConfig.llmBaseUrl).toBe("http://localhost:1234/v1");
    expect(loadedConfig.llmModel).toBe("local-model");
    expect(loadedConfig.llmPrimaryTimeoutMs).toBe(20000);
    expect(loadedConfig.llmFallbackTimeoutMs).toBe(60000);
  });

  it("requires a base URL and model for the OpenAI-compatible provider", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.LLM_PROVIDER = "openai-compatible";
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.ANTHROPIC_API_KEY;

    const { validateConfig } = await import("../src/config.js");

    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("LLM_BASE_URL")
    );
  });

  function setOpenAIConfig(baseUrl: string, apiKey?: string) {
    setRequired();
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_BASE_URL = baseUrl;
    process.env.LLM_MODEL = "local-model";
    if (apiKey === undefined) {
      delete process.env.LLM_API_KEY;
    } else {
      process.env.LLM_API_KEY = apiKey;
    }
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_API_KEY;
    delete process.env.LLM_FALLBACK_MODEL;
  }

  it.each([
    ["loopback", "http://127.0.0.1:1234/v1", undefined],
    ["loopback-alt", "http://127.0.0.2:1234/v1", undefined],
    ["IPv6 loopback", "http://[::1]:1234/v1", undefined],
    ["private", "http://192.168.1.4:1234/v1", "private-key"],
    ["Tailscale", "http://100.100.100.100:1234/v1", "tailscale-key"],
  ])("allows HTTP for %s LLM endpoints", async (_label, baseUrl, apiKey) => {
    setOpenAIConfig(baseUrl, apiKey);

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("rejects public HTTP LLM endpoints even with an API key", async () => {
    setOpenAIConfig("http://api.example.com/v1", "public-key");

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining("HTTPS"));
  });

  it.each([
    ["private", "http://10.0.0.5:1234/v1"],
    ["Tailscale", "http://100.100.100.100:1234/v1"],
  ])("requires an API key for non-loopback %s LLM endpoints", async (_label, baseUrl) => {
    setOpenAIConfig(baseUrl);

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("LLM_API_KEY")
    );
  });

  it("requires an API key for public HTTPS LLM endpoints", async () => {
    setOpenAIConfig("https://api.example.com/v1");

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("LLM_API_KEY")
    );
  });

  it("should exit if TELEGRAM_ALLOWED_USERS is empty", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.TELEGRAM_ALLOWED_USERS = "";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).toThrow("process.exit called");
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("TELEGRAM_ALLOWED_USERS")
    );
  });

  it("should pass when all required vars are set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.TELEGRAM_ALLOWED_USERS = "123,456";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
  });

  // Remote-send posture warnings (docs/remote-send.md). Non-fatal: validateConfig
  // must not exit, so the Telegram bot keeps running even when /api/send is
  // fail-closed.
  function setRequired() {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.MUNIN_API_KEY = "test-key";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
  }

  it("warns (does not exit) when HOST is non-loopback but no send key", async () => {
    setRequired();
    process.env.HOST = "100.100.100.100"; // a Tailscale IP
    delete process.env.RATATOSKR_SEND_API_KEY;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("DISABLED (fail-closed)")
    );
  });

  it("warns about the cleartext exposure of a wildcard bind", async () => {
    setRequired();
    process.env.HOST = "0.0.0.0";
    process.env.RATATOSKR_SEND_API_KEY = "set-so-only-wildcard-warning-fires";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("wildcard bind"));
  });

  it("emits no remote-send warning on the loopback default", async () => {
    setRequired();
    process.env.HOST = "127.0.0.1";
    delete process.env.RATATOSKR_SEND_API_KEY;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // Heimdall alert-echo partial-config (issue #16). Setting the URL without the
  // token silently degrades the echo (unauthenticated Bearer → Heimdall 401), so
  // validateConfig must warn loudly (but not exit).
  it("warns when HEIMDALL_INGEST_URL is set without HEIMDALL_ALERT_TOKEN", async () => {
    setRequired();
    process.env.HEIMDALL_INGEST_URL = "http://huginmunin:3033/api/alerts";
    delete process.env.HEIMDALL_ALERT_TOKEN;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("HEIMDALL_ALERT_TOKEN")
    );
  });

  it("emits no Heimdall warning when both URL and token are set", async () => {
    setRequired();
    process.env.HEIMDALL_INGEST_URL = "http://huginmunin:3033/api/alerts";
    process.env.HEIMDALL_ALERT_TOKEN = "tok";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // Concierge rate-limit config sanity (issue #3).
  it("warns when RATATOSKR_CONCIERGE_RATE_LIMIT is non-positive", async () => {
    setRequired();
    process.env.RATATOSKR_CONCIERGE_RATE_LIMIT = "0";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("RATATOSKR_CONCIERGE_RATE_LIMIT")
    );
  });

  it("emits no rate-limit warning on the default config", async () => {
    setRequired();
    delete process.env.RATATOSKR_CONCIERGE_RATE_LIMIT;
    delete process.env.RATATOSKR_CONCIERGE_RATE_WINDOW_MS;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("sanitizes an invalid rate limit/window to the safe defaults at runtime", async () => {
    setRequired();
    process.env.RATATOSKR_CONCIERGE_RATE_LIMIT = "0"; // would reject everything
    process.env.RATATOSKR_CONCIERGE_RATE_WINDOW_MS = "notanumber"; // NaN → no limit

    const { config } = await import("../src/config.js");
    expect(config.conciergeRateLimit).toBe(8);
    expect(config.conciergeRateWindowMs).toBe(60000);
  });

  // Voice transcription privacy posture (issue #1).
  it("warns when RATATOSKR_TRANSCRIBE_URL is a non-local endpoint", async () => {
    setRequired();
    process.env.RATATOSKR_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
    delete process.env.RATATOSKR_TRANSCRIBE_ALLOW_REMOTE;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("OFF-BOX"));
  });

  it("does not warn for a local transcription endpoint", async () => {
    setRequired();
    process.env.RATATOSKR_TRANSCRIBE_URL = "http://m5:8080/v1/audio/transcriptions";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("does not warn for a remote endpoint when ALLOW_REMOTE is set", async () => {
    setRequired();
    process.env.RATATOSKR_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
    process.env.RATATOSKR_TRANSCRIBE_ALLOW_REMOTE = "true";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // M5 triage gateway (issue #31) — same privacy posture as transcription:
  // message content must not silently leave the box.
  it("parses the triage gateway env vars with safe defaults", async () => {
    setRequired();
    delete process.env.RATATOSKR_TRIAGE_URL;
    delete process.env.RATATOSKR_TRIAGE_MODEL;
    delete process.env.RATATOSKR_TRIAGE_API_KEY;
    delete process.env.RATATOSKR_TRIAGE_TIMEOUT_MS;

    const { config } = await import("../src/config.js");
    expect(config.triageUrl).toBe(""); // feature OFF by default
    expect(config.triageModel).toBe("mellum");
    expect(config.triageApiKey).toBe("");
    expect(config.triageTimeoutMs).toBe(8000);
  });

  it("warns when RATATOSKR_TRIAGE_URL is a non-local endpoint", async () => {
    setRequired();
    process.env.RATATOSKR_TRIAGE_URL = "https://inference.example.com/delegate";
    process.env.RATATOSKR_TRIAGE_API_KEY = "k";
    delete process.env.RATATOSKR_TRIAGE_ALLOW_REMOTE;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("OFF-BOX"));
  });

  it("does not warn for a tailnet triage endpoint with a key set", async () => {
    setRequired();
    process.env.RATATOSKR_TRIAGE_URL = "http://100.100.100.100:8080/delegate";
    process.env.RATATOSKR_TRIAGE_API_KEY = "k";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("does not warn for a remote triage endpoint when ALLOW_REMOTE is set", async () => {
    setRequired();
    process.env.RATATOSKR_TRIAGE_URL = "https://inference.example.com/delegate";
    process.env.RATATOSKR_TRIAGE_API_KEY = "k";
    process.env.RATATOSKR_TRIAGE_ALLOW_REMOTE = "true";

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("warns when the triage URL is set without an API key (owner-tier /delegate would 401)", async () => {
    setRequired();
    process.env.RATATOSKR_TRIAGE_URL = "http://100.100.100.100:8080/delegate";
    delete process.env.RATATOSKR_TRIAGE_API_KEY;

    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig()).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("RATATOSKR_TRIAGE_API_KEY")
    );
  });

  it("sanitizes an invalid triage timeout to the default", async () => {
    setRequired();
    process.env.RATATOSKR_TRIAGE_TIMEOUT_MS = "notanumber";

    const { config } = await import("../src/config.js");
    expect(config.triageTimeoutMs).toBe(8000);
  });
});

describe("isLocalHost", () => {
  it("treats loopback, bare hostnames, .local, and private/Tailscale IPs as local", async () => {
    const { isLocalHost } = await import("../src/config.js");
    expect(isLocalHost("http://localhost:8080/x")).toBe(true);
    expect(isLocalHost("http://127.0.0.1/x")).toBe(true);
    expect(isLocalHost("http://m5:8080/x")).toBe(true); // bare hostname
    expect(isLocalHost("http://huginmunin.local/x")).toBe(true);
    expect(isLocalHost("http://10.0.0.5/x")).toBe(true);
    expect(isLocalHost("http://192.168.1.4/x")).toBe(true);
    expect(isLocalHost("http://172.16.0.9/x")).toBe(true);
    expect(isLocalHost("http://100.100.100.100/x")).toBe(true); // Tailscale CGNAT
  });

  it("treats public hosts/IPs as non-local", async () => {
    const { isLocalHost } = await import("../src/config.js");
    expect(isLocalHost("https://api.openai.com/v1")).toBe(false);
    expect(isLocalHost("http://8.8.8.8/x")).toBe(false);
    expect(isLocalHost("http://172.32.0.1/x")).toBe(false); // just outside 172.16/12
    expect(isLocalHost("not a url")).toBe(false);
  });
});
