import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config validation", () => {
  const originalEnv = process.env;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    mockError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    mockExit.mockRestore();
    mockError.mockRestore();
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
});
