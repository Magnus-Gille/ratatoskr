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
    process.env.HOST = "100.97.117.37"; // a Tailscale IP
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
});
