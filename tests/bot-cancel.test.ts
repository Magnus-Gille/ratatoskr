import { describe, expect, it, vi } from "vitest";
import { cancelTask, cancelledTaskTags } from "../src/bot.js";
import type { MuninClient } from "../src/munin-client.js";
import type { ResultPoller } from "../src/result-poller.js";

function poller() {
  return {
    stopPolling: vi.fn(),
  } as unknown as ResultPoller & { stopPolling: ReturnType<typeof vi.fn> };
}

function pendingMunin(writeResult: unknown = {}) {
  return {
    read: vi.fn().mockResolvedValue({
      found: true,
      id: "entry-1",
      namespace: "tasks/task-1",
      key: "status",
      content: "pending task",
      tags: [
        "pending",
        "instance:test",
        "context:repo:ratatoskr",
        "provenance:telegram",
        "cancelled",
      ],
      created_at: "2026-07-13T10:00:00.000Z",
      updated_at: "2026-07-13T10:01:00.000Z",
    }),
    write: vi.fn().mockResolvedValue(writeResult),
  } as unknown as MuninClient & {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
}

describe("cancelTask", () => {
  it("replaces every lifecycle tag while preserving provenance", () => {
    expect(
      cancelledTaskTags([
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "instance:test",
        "context:repo:ratatoskr",
        "provenance:telegram",
      ])
    ).toEqual([
      "instance:test",
      "context:repo:ratatoskr",
      "provenance:telegram",
      "cancelled",
    ]);
  });

  it("cancels with the status version as a compare-and-swap guard", async () => {
    const munin = pendingMunin();
    const resultPoller = poller();

    const result = await cancelTask("task-1", munin, resultPoller);

    expect(result.kind).toBe("cancelled");
    expect(munin.write).toHaveBeenCalledWith(
      "tasks/task-1",
      "status",
      "pending task",
      [
        "instance:test",
        "context:repo:ratatoskr",
        "provenance:telegram",
        "cancelled",
      ],
      "2026-07-13T10:01:00.000Z"
    );
    const writtenTags = munin.write.mock.calls[0][3] as string[];
    expect(writtenTags.filter((tag) => tag === "cancelled")).toHaveLength(1);
    expect(writtenTags).not.toEqual(
      expect.arrayContaining(["pending", "running", "completed", "failed"])
    );
    expect(resultPoller.stopPolling).toHaveBeenCalledWith("task-1");
  });

  it("returns a conflict response and keeps polling when Hugin wins the race", async () => {
    const munin = pendingMunin({
      success: false,
      error: "conflict",
      current_updated_at: "2026-07-13T10:01:01.000Z",
    });
    const resultPoller = poller();

    const result = await cancelTask("task-1", munin, resultPoller);

    expect(result).toEqual({
      kind: "conflict",
      message:
        "Task task-1 changed state while cancelling — refresh /status and try again.",
    });
    expect(resultPoller.stopPolling).not.toHaveBeenCalled();
  });

  it("refuses an unsafe cancellation when the read has no updated_at", async () => {
    const munin = pendingMunin();
    munin.read.mockResolvedValue({
      found: true,
      content: "pending task",
      tags: ["pending"],
    });
    const resultPoller = poller();

    const result = await cancelTask("task-1", munin, resultPoller);

    expect(result.kind).toBe("conflict");
    expect(munin.write).not.toHaveBeenCalled();
    expect(resultPoller.stopPolling).not.toHaveBeenCalled();
  });
});
