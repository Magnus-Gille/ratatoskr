/**
 * Resilient HTTP listener binding.
 *
 * When `HOST` is a non-loopback address — the Pi's Tailscale IP (see
 * docs/remote-send.md) — the bind can fail with `EADDRNOTAVAIL` if that address
 * isn't assigned yet: `tailscaled` not up at boot, or a runtime tailnet blip.
 * A `net.Server` reports bind failures by emitting an `'error'` event; with no
 * `'error'` listener Node re-throws and the *whole* process — Telegram bot
 * included — crash-loops, even though the bot itself needs no tailnet.
 *
 * `attachBindResilience` installs an `'error'` handler that retries the bind for
 * the transient `EADDRNOTAVAIL` case (bounded), and exits fatally otherwise so a
 * permanent failure falls through to systemd's `Restart=always` rather than
 * spinning forever. Decoupling the listener from the bot is exactly the
 * mitigation sketched in docs/remote-send.md ("Optional: make the bind
 * resilient").
 */

/** Retry cap — ~5 min at the default delay before giving up to the supervisor. */
export const MAX_BIND_RETRIES = 60;
/** Delay between bind retries. */
export const BIND_RETRY_DELAY_MS = 5000;

export type BindAction =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "fatal" };

/**
 * Pure decision: should a listener bind error be retried, or is it fatal?
 *
 * Only `EADDRNOTAVAIL` is treated as transient (the bind address isn't assigned
 * yet). Every other error — and exhausting the retry cap — is fatal, so the
 * supervisor (systemd `Restart=always`) takes over instead of the process
 * looping indefinitely on an unrecoverable bind.
 */
export function decideBindRetry(
  err: NodeJS.ErrnoException,
  retriesSoFar: number,
  maxRetries: number = MAX_BIND_RETRIES,
  delayMs: number = BIND_RETRY_DELAY_MS
): BindAction {
  if (err.code === "EADDRNOTAVAIL" && retriesSoFar < maxRetries) {
    return { kind: "retry", attempt: retriesSoFar + 1, delayMs };
  }
  return { kind: "fatal" };
}

/** Minimal surface of `http.Server` this module needs (kept narrow for testing). */
export interface ListenableServer {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  listen(port: number, host: string): unknown;
}

export interface BindResilienceOptions {
  maxRetries?: number;
  delayMs?: number;
  /** Schedule a delayed retry. Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Terminate the process on a fatal bind error. Injectable for tests. */
  exit?: (code: number) => void;
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * Attach a bounded bind-retry `'error'` handler to a server so a transient bind
 * failure retries instead of crashing the process. Call this immediately after
 * `app.listen(...)` on the returned server.
 */
export function attachBindResilience(
  server: ListenableServer,
  host: string,
  port: number,
  options: BindResilienceOptions = {}
): void {
  const maxRetries = options.maxRetries ?? MAX_BIND_RETRIES;
  const delayMs = options.delayMs ?? BIND_RETRY_DELAY_MS;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      setTimeout(fn, ms);
    });
  const exit = options.exit ?? ((code) => process.exit(code));
  const logger = options.logger ?? console;

  let retries = 0;
  server.on("error", (err: NodeJS.ErrnoException) => {
    const action = decideBindRetry(err, retries, maxRetries, delayMs);
    if (action.kind === "retry") {
      retries = action.attempt;
      logger.warn(
        `Bind ${host}:${port} unavailable (${err.code}) — retry ` +
          `${action.attempt}/${maxRetries} in ${action.delayMs}ms`
      );
      // The failed socket never bound, so re-listen directly — nothing to close.
      schedule(() => server.listen(port, host), action.delayMs);
      return;
    }
    logger.error(`HTTP server bind error on ${host}:${port} (giving up):`, err);
    exit(1);
  });
}
