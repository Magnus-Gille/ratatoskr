import { describe, it, expect } from "vitest";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows up to `limit` calls within the window", () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    expect(rl.tryAcquire("u", 0)).toBe(true);
    expect(rl.tryAcquire("u", 100)).toBe(true);
    expect(rl.tryAcquire("u", 200)).toBe(true);
  });

  it("rejects the call that exceeds the limit", () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    rl.tryAcquire("u", 0);
    rl.tryAcquire("u", 100);
    rl.tryAcquire("u", 200);
    expect(rl.tryAcquire("u", 300)).toBe(false);
  });

  it("does not consume a slot when rejecting (rejection is not a hit)", () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("u", 0)).toBe(true);
    expect(rl.tryAcquire("u", 100)).toBe(false);
    expect(rl.tryAcquire("u", 200)).toBe(false);
    // After the first hit ages out, exactly one slot frees up.
    expect(rl.tryAcquire("u", 1001)).toBe(true);
  });

  it("refills as old hits slide out of the window", () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    expect(rl.tryAcquire("u", 0)).toBe(true);
    expect(rl.tryAcquire("u", 500)).toBe(true);
    expect(rl.tryAcquire("u", 600)).toBe(false); // window holds 2
    // t=0 hit expires at t=1001 → one slot frees
    expect(rl.tryAcquire("u", 1001)).toBe(true);
    // t=500 hit still in window → full again
    expect(rl.tryAcquire("u", 1002)).toBe(false);
  });

  it("tracks each key independently", () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("b", 0)).toBe(true); // different key, own budget
    expect(rl.tryAcquire("a", 1)).toBe(false);
    expect(rl.tryAcquire("b", 1)).toBe(false);
  });

  it("a window boundary is exclusive (a hit exactly windowMs old has expired)", () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("u", 0)).toBe(true);
    // at t=1000 the t=0 hit is exactly windowMs old → expired → allowed
    expect(rl.tryAcquire("u", 1000)).toBe(true);
  });

  it("a limit of 0 rejects everything", () => {
    const rl = new SlidingWindowRateLimiter(0, 1000);
    expect(rl.tryAcquire("u", 0)).toBe(false);
  });
});
