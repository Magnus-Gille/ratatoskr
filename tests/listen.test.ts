import { describe, it, expect, vi } from "vitest";
import {
  decideBindRetry,
  attachBindResilience,
  MAX_BIND_RETRIES,
  BIND_RETRY_DELAY_MS,
  type ListenableServer,
} from "../src/listen.js";

function err(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`bind ${code}`), { code });
}

// ---------------------------------------------------------------------------
// decideBindRetry — pure decision function
// ---------------------------------------------------------------------------

describe("decideBindRetry — pure", () => {
  it("retries EADDRNOTAVAIL below the cap", () => {
    expect(decideBindRetry(err("EADDRNOTAVAIL"), 0, 60, 5000)).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: 5000,
    });
  });

  it("carries the attempt number forward from retriesSoFar", () => {
    expect(decideBindRetry(err("EADDRNOTAVAIL"), 41, 60, 5000)).toEqual({
      kind: "retry",
      attempt: 42,
      delayMs: 5000,
    });
  });

  it("is fatal once the retry cap is reached", () => {
    expect(decideBindRetry(err("EADDRNOTAVAIL"), 60, 60).kind).toBe("fatal");
  });

  it("is fatal for a port already in use (EADDRINUSE is not transient here)", () => {
    expect(decideBindRetry(err("EADDRINUSE"), 0, 60).kind).toBe("fatal");
  });

  it("is fatal for a permission error (EACCES)", () => {
    expect(decideBindRetry(err("EACCES"), 0, 60).kind).toBe("fatal");
  });

  it("applies sane defaults when cap/delay omitted", () => {
    expect(decideBindRetry(err("EADDRNOTAVAIL"), 0)).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: BIND_RETRY_DELAY_MS,
    });
    expect(MAX_BIND_RETRIES).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// attachBindResilience — thin wrapper over a server's 'error' event
// ---------------------------------------------------------------------------

function makeFakeServer() {
  let errorHandler: ((e: NodeJS.ErrnoException) => void) | null = null;
  const server = {
    listen: vi.fn(),
    on: vi.fn((event: string, handler: (e: NodeJS.ErrnoException) => void) => {
      if (event === "error") errorHandler = handler;
      return server;
    }),
    emitError(e: NodeJS.ErrnoException) {
      if (!errorHandler) throw new Error("no 'error' handler attached");
      errorHandler(e);
    },
  };
  return server;
}

const HOST = "100.97.117.37";
const PORT = 3034;

describe("attachBindResilience", () => {
  it("retries the bind on EADDRNOTAVAIL instead of exiting", () => {
    const server = makeFakeServer();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const exit = vi.fn();

    attachBindResilience(server as unknown as ListenableServer, HOST, PORT, {
      maxRetries: 3,
      delayMs: 5000,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      exit,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    server.emitError(err("EADDRNOTAVAIL"));

    expect(exit).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(5000);

    // Running the scheduled retry re-binds the same host:port.
    scheduled[0].fn();
    expect(server.listen).toHaveBeenCalledWith(PORT, HOST);
  });

  it("keeps the process alive while retries remain (bot survives a tailnet blip)", () => {
    const server = makeFakeServer();
    const exit = vi.fn();
    attachBindResilience(server as unknown as ListenableServer, HOST, PORT, {
      maxRetries: 5,
      delayMs: 1,
      schedule: () => {},
      exit,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    server.emitError(err("EADDRNOTAVAIL"));
    server.emitError(err("EADDRNOTAVAIL"));

    expect(exit).not.toHaveBeenCalled();
  });

  it("exits fatally once the retry cap is exhausted (falls through to systemd)", () => {
    const server = makeFakeServer();
    const exit = vi.fn();
    attachBindResilience(server as unknown as ListenableServer, HOST, PORT, {
      maxRetries: 2,
      delayMs: 1,
      schedule: () => {},
      exit,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    server.emitError(err("EADDRNOTAVAIL")); // retry 1
    server.emitError(err("EADDRNOTAVAIL")); // retry 2
    expect(exit).not.toHaveBeenCalled();
    server.emitError(err("EADDRNOTAVAIL")); // cap exhausted → fatal
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits immediately on a non-transient error without scheduling a retry", () => {
    const server = makeFakeServer();
    const scheduled: Array<() => void> = [];
    const exit = vi.fn();
    attachBindResilience(server as unknown as ListenableServer, HOST, PORT, {
      schedule: (fn) => {
        scheduled.push(fn);
      },
      exit,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    server.emitError(err("EADDRINUSE"));
    expect(scheduled).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
