import { describe, it, expect, vi, afterEach } from "vitest";
import { MessageTracker } from "../src/message-tracker.js";

describe("MessageTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("track() and lookup() — stores and retrieves a message", () => {
    const tracker = new MessageTracker();
    tracker.track(101, { type: "result", taskId: "abc", snippet: "hello" });
    const result = tracker.lookup(101);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("result");
    expect(result!.taskId).toBe("abc");
    expect(result!.snippet).toBe("hello");
  });

  it("lookup() returns null for unknown message IDs", () => {
    const tracker = new MessageTracker();
    expect(tracker.lookup(9999)).toBeNull();
  });

  it("size reflects the number of tracked messages", () => {
    const tracker = new MessageTracker();
    expect(tracker.size).toBe(0);
    tracker.track(1, { type: "ack" });
    tracker.track(2, { type: "clarify", snippet: "What do you mean?" });
    expect(tracker.size).toBe(2);
  });

  it("TTL expiry — tracked messages expire after ttlMs", () => {
    vi.useFakeTimers();
    const ttlMs = 5000;
    const tracker = new MessageTracker(ttlMs);

    tracker.track(42, { type: "answer", snippet: "Yes." });
    expect(tracker.lookup(42)).not.toBeNull();

    // Advance time beyond TTL
    vi.advanceTimersByTime(ttlMs + 1);

    // A subsequent lookup triggers cleanup — old entry should be gone
    expect(tracker.lookup(42)).toBeNull();
  });

  it("cleanup removes expired entries on track()", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const tracker = new MessageTracker(ttlMs);

    tracker.track(10, { type: "result", taskId: "t1" });
    tracker.track(11, { type: "result", taskId: "t2" });
    expect(tracker.size).toBe(2);

    // Advance past TTL
    vi.advanceTimersByTime(ttlMs + 1);

    // Tracking a new message triggers cleanup of expired ones
    tracker.track(20, { type: "ack", taskId: "t3" });
    expect(tracker.size).toBe(1); // Only the new one remains
  });

  it("tracks all message types without taskId or snippet", () => {
    const tracker = new MessageTracker();
    const types = ["result", "status", "clarify", "answer", "ack"] as const;
    types.forEach((type, i) => {
      tracker.track(i, { type });
    });
    expect(tracker.size).toBe(types.length);
    types.forEach((type, i) => {
      const msg = tracker.lookup(i);
      expect(msg?.type).toBe(type);
      expect(msg?.taskId).toBeUndefined();
      expect(msg?.snippet).toBeUndefined();
    });
  });
});
