/**
 * Shared cancellation and deadline handling for outbound service calls.
 *
 * Every request gets a bounded timeout and is also tied to the process lifetime.
 * Calling `abort()` during shutdown immediately cancels in-flight requests instead
 * of waiting for their individual deadlines or the forced-exit timer.
 */

export class RequestTimeoutError extends Error {
  constructor(label: string, timeoutMs: number, options?: ErrorOptions) {
    super(`${label} timed out after ${timeoutMs}ms`, options);
    this.name = "RequestTimeoutError";
  }
}

export class ServiceShutdownError extends Error {
  constructor(label: string, options?: ErrorOptions) {
    super(`${label} aborted because Ratatoskr is shutting down`, options);
    this.name = "ServiceShutdownError";
  }
}

const deadlineSources = new WeakMap<AbortSignal, AbortSignal>();

export class AbortContext {
  private readonly controller = new AbortController();

  deadline(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([this.controller.signal, timeout]);
    // On Node 20, AbortSignal.any() does not keep its source signals alive, so
    // the AbortSignal.timeout() source can be garbage-collected before it
    // fires and the deadline never aborts. Tie the timeout's lifetime to the
    // combined signal the caller holds.
    deadlineSources.set(combined, timeout);
    return combined;
  }

  abort(): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new Error("Ratatoskr service shutdown"));
    }
  }

  normalize(
    err: unknown,
    signal: AbortSignal,
    label: string,
    timeoutMs: number
  ): unknown {
    if (!signal.aborted) return err;
    const options = err instanceof Error ? { cause: err } : undefined;
    if (this.controller.signal.aborted) {
      return new ServiceShutdownError(label, options);
    }
    return new RequestTimeoutError(label, timeoutMs, options);
  }
}

export const runtimeAbort = new AbortContext();
