import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageAggregator } from "../src/message-aggregator.js";

describe("MessageAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a single message after the window elapses", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-1", "hello world");
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2500);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("chat-1", "hello world");
  });

  it("concatenates rapid fragments and flushes them as one message", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-1", "part one");
    vi.advanceTimersByTime(500);

    agg.push("chat-1", "part two");
    vi.advanceTimersByTime(500);

    agg.push("chat-1", "part three");

    // Timer has not fired yet — nothing delivered.
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2500);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      "chat-1",
      "part one part two part three"
    );
  });

  it("preserves fragment order", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    const fragments = ["alpha", "beta", "gamma", "delta"];
    for (const f of fragments) {
      agg.push("chat-1", f);
    }
    vi.advanceTimersByTime(2500);

    const received: string = handler.mock.calls[0][1];
    expect(received).toBe("alpha beta gamma delta");
  });

  it("does not mix messages from different chat IDs", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-A", "message from A");
    agg.push("chat-B", "message from B");

    vi.advanceTimersByTime(2500);

    expect(handler).toHaveBeenCalledTimes(2);

    const callsById = new Map(
      handler.mock.calls.map(([chatId, text]) => [chatId, text])
    );
    expect(callsById.get("chat-A")).toBe("message from A");
    expect(callsById.get("chat-B")).toBe("message from B");
  });

  it("resets the debounce window on each new fragment", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-1", "first");
    vi.advanceTimersByTime(2000); // not yet — window resets on next push

    agg.push("chat-1", "second");
    vi.advanceTimersByTime(2000); // still not yet (only 2000ms since last push)

    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500); // 2500ms since last push — fires now

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("chat-1", "first second");
  });

  it("flushNow delivers immediately without waiting for the timer", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-1", "urgent");
    agg.flushNow("chat-1");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("chat-1", "urgent");

    // Timer should have been cancelled — advancing time must not double-fire.
    vi.advanceTimersByTime(2500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("flushAll delivers all pending chats", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    agg.push("chat-A", "a");
    agg.push("chat-B", "b");
    agg.push("chat-C", "c");

    expect(agg.pendingCount).toBe(3);

    agg.flushAll();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(agg.pendingCount).toBe(0);
  });

  it("pendingCount tracks active chat windows accurately", () => {
    const handler = vi.fn();
    const agg = new MessageAggregator(2500, handler);

    expect(agg.pendingCount).toBe(0);

    agg.push("chat-1", "hi");
    expect(agg.pendingCount).toBe(1);

    agg.push("chat-2", "hey");
    expect(agg.pendingCount).toBe(2);

    vi.advanceTimersByTime(2500);

    expect(agg.pendingCount).toBe(0);
  });
});
