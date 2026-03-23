import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    pollIntervalMs: 100,
    maxPollDurationMs: 500,
  },
}));

import { ResultPoller } from "../src/result-poller.js";
import type { MuninClient } from "../src/munin-client.js";

function mockMunin(
  overrides: Partial<MuninClient> = {}
): MuninClient {
  return {
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as MuninClient;
}

describe("ResultPoller", () => {
  let poller: ResultPoller;

  afterEach(() => {
    poller?.stopAll();
  });

  it("should call onComplete when task is completed", async () => {
    let callCount = 0;
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (ns, key) => {
        callCount++;
        if (key === "status") {
          if (callCount >= 2) {
            return {
              found: true,
              content: "done",
              tags: ["completed"],
            };
          }
          return {
            found: true,
            content: "running",
            tags: ["running"],
          };
        }
        if (key === "result") {
          return {
            found: true,
            content: "Task completed successfully!",
            tags: [],
          };
        }
        return null;
      }),
    });

    poller = new ResultPoller(munin);

    const result = await new Promise<string>((resolve) => {
      poller.startPolling("test-task", resolve);
    });

    expect(result).toBe("Task completed successfully!");
  });

  it("should timeout after maxPollDurationMs", async () => {
    const munin = mockMunin({
      read: vi.fn().mockResolvedValue({
        found: true,
        content: "still running",
        tags: ["running"],
      }),
    });

    poller = new ResultPoller(munin);

    const result = await new Promise<string>((resolve) => {
      poller.startPolling("timeout-task", resolve);
    });

    expect(result).toContain("timed out");
  });

  it("should track active poll count", () => {
    const munin = mockMunin({
      read: vi.fn().mockResolvedValue({
        found: true,
        content: "running",
        tags: ["running"],
      }),
    });

    poller = new ResultPoller(munin);
    expect(poller.activePollCount).toBe(0);

    poller.startPolling("task-1", () => {});
    expect(poller.activePollCount).toBe(1);

    poller.startPolling("task-2", () => {});
    expect(poller.activePollCount).toBe(2);

    poller.stopPolling("task-1");
    expect(poller.activePollCount).toBe(1);

    poller.stopAll();
    expect(poller.activePollCount).toBe(0);
  });

  it("should not double-poll the same task", () => {
    const munin = mockMunin({
      read: vi.fn().mockResolvedValue({
        found: true,
        content: "running",
        tags: ["running"],
      }),
    });

    poller = new ResultPoller(munin);
    poller.startPolling("same-task", () => {});
    poller.startPolling("same-task", () => {});
    expect(poller.activePollCount).toBe(1);
  });
});
