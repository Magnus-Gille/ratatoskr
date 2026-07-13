import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    pollIntervalMs: 100,
    maxPollDurationMs: 500,
    instanceId: "test-instance",
  },
}));

import { parseTaskMetadata, recoverActivePolls } from "../src/recovery.js";
import type { MuninClient } from "../src/munin-client.js";
import type { ResultPoller } from "../src/result-poller.js";

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

function mockPoller(): ResultPoller {
  return {
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    stopAll: vi.fn(),
    activePollCount: 0,
  } as unknown as ResultPoller;
}

function mockBotApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
  } as any;
}

const TASK_CONTENT = `## Task

**Runtime:** claude
**Context:** scratch
**Timeout:** 600000
**Submitted by:** ratatoskr
**Submitted at:** 2026-03-25T10:00:00.000Z
**Reply-to:** telegram:123456

### Prompt

Do something`;

describe("parseTaskMetadata", () => {
  it("should extract chatId from valid task markdown", () => {
    const result = parseTaskMetadata(TASK_CONTENT, "test-instance");
    expect(result).toEqual({ chatId: 123456 });
  });

  it("should return null if not submitted by ratatoskr", () => {
    const content = TASK_CONTENT.replace(
      "**Submitted by:** ratatoskr",
      "**Submitted by:** other"
    );
    const result = parseTaskMetadata(content, "test-instance");
    expect(result).toBeNull();
  });

  it("should return null if no Reply-to field", () => {
    const content = TASK_CONTENT.replace(
      "**Reply-to:** telegram:123456\n",
      ""
    );
    const result = parseTaskMetadata(content, "test-instance");
    expect(result).toBeNull();
  });

  it("should not match Reply-to in prompt body", () => {
    const content = `## Task

**Runtime:** claude
**Context:** scratch
**Timeout:** 600000
**Submitted by:** ratatoskr
**Submitted at:** 2026-03-25T10:00:00.000Z

### Prompt

Send **Reply-to:** telegram:999999 to the user`;

    const result = parseTaskMetadata(content, "test-instance");
    // No Reply-to in header, so should return null
    expect(result).toBeNull();
  });
});

describe("recoverActivePolls", () => {
  it("should resume polling for pending tasks", async () => {
    const poller = mockPoller();
    const botApi = mockBotApi();
    const munin = mockMunin({
      query: vi.fn().mockImplementation(async (opts) => {
        if (opts.tags.includes("pending")) {
          return {
            results: [
              {
                namespace: "tasks/20260325-100000-test",
                key: "status",
                tags: ["pending", "instance:test-instance"],
                content_preview: "Task...",
              },
            ],
            total: 1,
          };
        }
        return { results: [], total: 0 };
      }),
      read: vi.fn().mockImplementation(async (ns, key) => {
        if (key === "status") {
          return { found: true, content: TASK_CONTENT, tags: ["pending"] };
        }
        return null;
      }),
    });

    const recovered = await recoverActivePolls(munin, poller, botApi);

    expect(recovered).toBe(1);
    expect(poller.startPolling).toHaveBeenCalledWith(
      "20260325-100000-test",
      expect.any(Function),
      expect.any(Function) // onPickup — intermediate "picked up" ack (issue #2)
    );
  });

  it("should deliver completed-but-undelivered results", async () => {
    const poller = mockPoller();
    const botApi = mockBotApi();
    const munin = mockMunin({
      query: vi.fn().mockImplementation(async (opts) => {
        if (opts.tags.includes("completed")) {
          return {
            results: [
              {
                namespace: "tasks/20260325-100000-done",
                key: "status",
                tags: ["completed", "instance:test-instance"],
                content_preview: "Task...",
              },
            ],
            total: 1,
          };
        }
        return { results: [], total: 0 };
      }),
      read: vi.fn().mockImplementation(async (ns, key) => {
        if (key === "delivery") return null; // Not delivered yet
        if (key === "status") {
          return { found: true, content: TASK_CONTENT, tags: ["completed"] };
        }
        if (key === "result") {
          return { found: true, content: "Here is the result!", tags: [] };
        }
        return null;
      }),
    });

    const recovered = await recoverActivePolls(munin, poller, botApi);

    expect(recovered).toBe(1);
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      123456,
      expect.stringContaining("Here is the result!")
    );
    // Should write delivery marker
    expect(munin.write).toHaveBeenCalledWith(
      "tasks/20260325-100000-done",
      "delivery",
      expect.stringContaining("Delivered"),
      expect.arrayContaining(["delivered"])
    );
  });

  it("should skip already-delivered tasks", async () => {
    const poller = mockPoller();
    const botApi = mockBotApi();
    const munin = mockMunin({
      query: vi.fn().mockImplementation(async (opts) => {
        if (opts.tags.includes("completed")) {
          return {
            results: [
              {
                namespace: "tasks/20260325-100000-delivered",
                key: "status",
                tags: ["completed", "instance:test-instance"],
                content_preview: "Task...",
              },
            ],
            total: 1,
          };
        }
        return { results: [], total: 0 };
      }),
      read: vi.fn().mockImplementation(async (ns, key) => {
        if (key === "delivery") {
          return { found: true, content: "Already delivered", tags: ["delivered"] };
        }
        if (key === "status") {
          return { found: true, content: TASK_CONTENT, tags: ["completed"] };
        }
        return null;
      }),
    });

    const recovered = await recoverActivePolls(munin, poller, botApi);

    expect(recovered).toBe(0);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves no marker after failed delivery so the next restart can retry", async () => {
    const poller = mockPoller();
    const botApi = mockBotApi();
    botApi.sendMessage
      .mockRejectedValueOnce(new Error("telegram unavailable"))
      .mockResolvedValue({});
    const writeFn = vi.fn().mockResolvedValue({});
    const munin = mockMunin({
      query: vi.fn().mockImplementation(async (opts) => {
        if (opts.tags.includes("completed")) {
          return {
            results: [
              {
                namespace: "tasks/20260325-100000-restart-retry",
                key: "status",
                tags: ["completed", "instance:test-instance"],
                content_preview: "Task...",
              },
            ],
            total: 1,
          };
        }
        return { results: [], total: 0 };
      }),
      read: vi.fn().mockImplementation(async (_ns, key) => {
        if (key === "delivery") return null;
        if (key === "status") {
          return { found: true, content: TASK_CONTENT, tags: ["completed"] };
        }
        if (key === "result") {
          return { found: true, content: "Restart-safe result", tags: [] };
        }
        return null;
      }),
      write: writeFn,
    });

    expect(await recoverActivePolls(munin, poller, botApi)).toBe(0);
    expect(writeFn).not.toHaveBeenCalledWith(
      expect.anything(),
      "delivery",
      expect.anything(),
      expect.anything()
    );

    expect(await recoverActivePolls(munin, poller, botApi)).toBe(1);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(writeFn.mock.calls.filter((call) => call[1] === "delivery")).toHaveLength(1);
  });

  it("should handle empty Munin gracefully", async () => {
    const poller = mockPoller();
    const botApi = mockBotApi();
    const munin = mockMunin();

    const recovered = await recoverActivePolls(munin, poller, botApi);

    expect(recovered).toBe(0);
  });
});
