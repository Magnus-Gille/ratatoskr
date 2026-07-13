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
    await new Promise((resolve) => setImmediate(resolve));
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

  // --- Intermediate "picked up" notification (issue #2) ---------------------
  it("calls onPickup on the first running transition", async () => {
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "status") {
          return { found: true, content: "running", tags: ["running"] };
        }
        return null; // pickup marker absent
      }),
    });
    poller = new ResultPoller(munin);

    const msg = await new Promise<string>((resolve) => {
      poller.startPolling(
        "pickup-task",
        async () => {},
        async (m) => resolve(m)
      );
    });
    expect(msg).toContain("picked up");
  });

  it("acks pickup only once across multiple running polls", async () => {
    const onPickup = vi.fn().mockResolvedValue(undefined);
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) =>
        key === "status"
          ? { found: true, content: "running", tags: ["running"] }
          : null
      ),
    });
    poller = new ResultPoller(munin);
    poller.startPolling("once-task", async () => {}, onPickup);

    await new Promise((r) => setTimeout(r, 250)); // ≥2 poll intervals
    expect(onPickup).toHaveBeenCalledTimes(1);
  });

  it("writes a picked-up marker after acking", async () => {
    const writeFn = vi.fn().mockResolvedValue({});
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) =>
        key === "status"
          ? { found: true, content: "running", tags: ["running"] }
          : null
      ),
      write: writeFn,
    });
    poller = new ResultPoller(munin);

    await new Promise<void>((resolve) => {
      poller.startPolling("marker-task", async () => {}, async () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50)); // allow marker write

    expect(writeFn).toHaveBeenCalledWith(
      "tasks/marker-task",
      "pickup",
      expect.any(String),
      expect.arrayContaining(["picked-up", "instance:test-instance"])
    );
  });

  it("skips the pickup ack when a persisted marker already exists (no re-ack across restart)", async () => {
    const onPickup = vi.fn().mockResolvedValue(undefined);
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "status") {
          return { found: true, content: "running", tags: ["running"] };
        }
        if (key === "pickup") {
          return { found: true, content: "already acked", tags: ["picked-up"] };
        }
        return null;
      }),
    });
    poller = new ResultPoller(munin);
    poller.startPolling("restart-task", async () => {}, onPickup);

    await new Promise((r) => setTimeout(r, 250));
    expect(onPickup).not.toHaveBeenCalled();
  });

  it("does not ack pickup when the task is already terminal on first poll", async () => {
    const onPickup = vi.fn().mockResolvedValue(undefined);
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "status") {
          return { found: true, content: "done", tags: ["completed"] };
        }
        if (key === "result") {
          return { found: true, content: "Result!", tags: [] };
        }
        return null;
      }),
    });
    poller = new ResultPoller(munin);

    const result = await new Promise<string>((resolve) => {
      poller.startPolling("fast-task", async (r) => resolve(r), onPickup);
    });
    expect(result).toBe("Result!");
    expect(onPickup).not.toHaveBeenCalled();
  });

  it("never touches the pickup marker when no onPickup is provided (backwards compat)", async () => {
    const readFn = vi.fn().mockImplementation(async (_ns: string, key: string) =>
      key === "status"
        ? { found: true, content: "running", tags: ["running"] }
        : null
    );
    const munin = mockMunin({ read: readFn });
    poller = new ResultPoller(munin);
    poller.startPolling("legacy-task", async () => {});

    await new Promise((r) => setTimeout(r, 250));
    expect(readFn).not.toHaveBeenCalledWith("tasks/legacy-task", "pickup");
  });

  it("retries the pickup ack on failure and writes the marker only after success", async () => {
    const writeFn = vi.fn().mockResolvedValue({});
    let pickupCalls = 0;
    const onPickup = vi.fn().mockImplementation(async () => {
      pickupCalls++;
      if (pickupCalls === 1) throw new Error("telegram down");
      // second attempt succeeds
    });
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) =>
        key === "status"
          ? { found: true, content: "running", tags: ["running"] }
          : null // no persisted pickup marker
      ),
      write: writeFn,
    });
    poller = new ResultPoller(munin);
    poller.startPolling("retry-task", async () => {}, onPickup);

    await new Promise((r) => setTimeout(r, 350));
    expect(onPickup.mock.calls.length).toBeGreaterThanOrEqual(2); // retried
    const pickupWrites = writeFn.mock.calls.filter((c) => c[1] === "pickup");
    expect(pickupWrites.length).toBe(1); // marker written once, after success
  });

  it("serializes overlapping polls so onComplete fires once despite a slow read", async () => {
    let statusCalls = 0;
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "status") {
          statusCalls++;
          // Make the first read slower than the poll interval so the next tick
          // overlaps it — the busy guard must skip the overlapping poll.
          if (statusCalls === 1) await new Promise((r) => setTimeout(r, 150));
          return { found: true, content: "done", tags: ["completed"] };
        }
        if (key === "result") return { found: true, content: "R", tags: [] };
        return null;
      }),
    });
    poller = new ResultPoller(munin);
    poller.startPolling("overlap-task", onComplete);

    await new Promise((r) => setTimeout(r, 300));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("retries terminal delivery after callback failure and marks only after success", async () => {
    const writeFn = vi.fn().mockResolvedValue({});
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
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
    const onComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram unavailable"))
      .mockResolvedValue(undefined);
    poller = new ResultPoller(munin);

    poller.startPolling("retry-result", onComplete);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(writeFn.mock.calls.filter((call) => call[1] === "delivery")).toHaveLength(1);
    expect(poller.activePollCount).toBe(0);
  });

  it("retries a failed marker without resending a confirmed Telegram result", async () => {
    const writeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("munin marker write failed"))
      .mockResolvedValue({});
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
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
    const onComplete = vi.fn().mockResolvedValue(undefined);
    poller = new ResultPoller(munin);

    poller.startPolling("marker-retry", onComplete);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(writeFn.mock.calls.filter((call) => call[1] === "delivery")).toHaveLength(2);
    expect(poller.activePollCount).toBe(0);
  });

  it("continues polling after a bounded Munin timeout", async () => {
    let statusReads = 0;
    const munin = mockMunin({
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "status") {
          statusReads += 1;
          if (statusReads === 1) {
            const err = new Error("Munin request timed out after 10ms");
            err.name = "RequestTimeoutError";
            throw err;
          }
          return { found: true, content: "done", tags: ["completed"] };
        }
        if (key === "result") {
          return { found: true, content: "Recovered", tags: [] };
        }
        return null;
      }),
    });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    poller = new ResultPoller(munin);

    poller.startPolling("timeout-recovery", onComplete);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(statusReads).toBeGreaterThanOrEqual(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(poller.activePollCount).toBe(0);
  });
});
