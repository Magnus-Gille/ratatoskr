import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    pollIntervalMs: 100,
    maxPollDurationMs: 500,
    instanceId: "test-instance",
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
      poller.startPolling("test-task", async (r) => resolve(r));
    });

    expect(result).toBe("Task completed successfully!");
  });

  it("should write delivery marker after completion", async () => {
    const writeFn = vi.fn().mockResolvedValue({});
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (ns, key) => {
        if (key === "status") {
          return { found: true, content: "done", tags: ["completed"] };
        }
        if (key === "result") {
          return { found: true, content: "Result!", tags: [] };
        }
        return null;
      }),
      write: writeFn,
    });

    poller = new ResultPoller(munin);

    await new Promise<string>((resolve) => {
      poller.startPolling("delivery-test", async (r) => resolve(r));
    });

    // Allow microtask for delivery write
    await new Promise((r) => setTimeout(r, 50));

    expect(writeFn).toHaveBeenCalledWith(
      "tasks/delivery-test",
      "delivery",
      expect.stringContaining("Delivered"),
      expect.arrayContaining(["delivered", "instance:test-instance"])
    );
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
      poller.startPolling("timeout-task", async (r) => resolve(r));
    });

    expect(result).toContain("Lost track");
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

    poller.startPolling("task-1", async () => {});
    expect(poller.activePollCount).toBe(1);

    poller.startPolling("task-2", async () => {});
    expect(poller.activePollCount).toBe(2);

    poller.stopPolling("task-1");
    expect(poller.activePollCount).toBe(1);

    poller.stopAll();
    expect(poller.activePollCount).toBe(0);
  });

  it("should treat cancelled as terminal state", async () => {
    const munin = mockMunin({
      read: vi.fn().mockResolvedValue({
        found: true,
        content: "pending",
        tags: ["cancelled"],
      }),
    });

    poller = new ResultPoller(munin);

    const result = await new Promise<string>((resolve) => {
      poller.startPolling("cancelled-task", async (r) => resolve(r));
    });

    expect(result).toContain("cancelled");
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
    poller.startPolling("same-task", async () => {});
    poller.startPolling("same-task", async () => {});
    expect(poller.activePollCount).toBe(1);
  });
});
