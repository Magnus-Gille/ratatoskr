/**
 * Per-key sliding-window rate limiter (issue #3).
 *
 * Bounds how often a key (a Telegram chat id) may trigger an action — used to
 * cap concierge (Claude Haiku) calls so a burst of messages can't fan out into
 * unbounded API calls. Pure and time-injectable for deterministic tests.
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
      this.hits.set(key, recent); // persist the pruned list
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
