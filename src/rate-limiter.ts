/**
 * Per-key sliding-window rate limiter (issue #3).
 *
 * Bounds how often a key (a Telegram chat id) may trigger an action — used to
 * cap concierge (Claude Haiku) calls so a burst of messages can't fan out into
 * unbounded API calls. Pure and time-injectable for deterministic tests.
 *
 * Memory: timestamps are pruned lazily on each `tryAcquire`, and a key is dropped
 * once its pruned list is empty. The live key set is therefore bounded by the
 * active keyspace — fine here, since keys are the (allowlisted, bounded) set of
 * chat ids. Reusing this for an unbounded/attacker-controlled keyspace would want
 * a periodic sweep.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * @param limit    max allowed calls within the window (≤0 rejects everything)
   * @param windowMs sliding window size in milliseconds
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /**
   * Record an attempt for `key`. Returns true if it is within the limit (and
   * counts it as a hit), false if it exceeds the limit (a rejection is NOT
   * counted, so it can't push later calls further out).
   */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      // Persist the pruned list, or drop the key entirely if nothing remains
      // (e.g. a limit of 0) so inactive keys don't accumulate.
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
