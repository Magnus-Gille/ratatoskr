import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireSendApiKey } from "../src/auth.js";
import { LOOPBACK_BIND_HOSTS } from "../src/loopback.js";

// Startup validation (validateConfig) and the /api/send auth check must agree on
// which HOST values are loopback. With no send key configured:
//   - loopback   → no "DISABLED (fail-closed)" warning, auth middleware calls next()
//   - non-loopback → DISABLED warning emitted, auth middleware answers 401
const CASES: Array<{ host: string; loopback: boolean }> = [
  { host: "127.0.0.1", loopback: true },
  { host: "::1", loopback: true },
  { host: "localhost", loopback: true },
  { host: "127.0.0.2", loopback: false },
  { host: "0.0.0.0", loopback: false },
  { host: "example.com", loopback: false },
];

describe("loopback allowlist agreement (startup validation vs. auth)", () => {
  const originalEnv = process.env;
  let mockWarn: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.MUNIN_API_KEY = "test-key";
    delete process.env.RATATOSKR_SEND_API_KEY;
    mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    mockWarn.mockRestore();
    mockError.mockRestore();
    mockExit.mockRestore();
  });

  it("exports exactly the loopback set used by auth", () => {
    expect([...LOOPBACK_BIND_HOSTS].sort()).toEqual(
      ["127.0.0.1", "::1", "localhost"].sort()
    );
  });

  it.each(CASES)(
    "HOST=$host: startup warning and auth check agree (loopback=$loopback)",
    async ({ host, loopback }) => {
      process.env.HOST = host;
      const { validateConfig } = await import("../src/config.js");
      expect(() => validateConfig()).not.toThrow();
      const startupWarned = mockWarn.mock.calls.some((call) =>
        String(call[0]).includes("DISABLED (fail-closed)")
      );

      const mw = requireSendApiKey("", host);
      const next = vi.fn();
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      mw({ headers: {} } as any, res, next);
      const authAllowed = next.mock.calls.length === 1;

      expect(authAllowed).toBe(loopback);
      expect(startupWarned).toBe(!loopback);
      expect(startupWarned).toBe(!authAllowed);
    }
  );
});
