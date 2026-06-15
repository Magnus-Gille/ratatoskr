import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    allowedUsers: ["12345678"],
    consolidationPollMs: 60000,
  },
}));

import {
  decideAlert,
  ConsolidationHealthPoller,
  type AlertState,
  type ConsolidationHealthEntry,
} from "../src/consolidation-health-poller.js";
import type { MuninClient } from "../src/munin-client.js";
import type { Api } from "grammy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<ConsolidationHealthEntry> = {}
): ConsolidationHealthEntry {
  return {
    status: "healthy",
    failures: 0,
    max_failures: 5,
    ...overrides,
  };
}

const noAlert: AlertState = { lastAlertedStatus: null, lastErrorAt: null };

function mockMunin(
  readResult: Awaited<ReturnType<MuninClient["read"]>>
): MuninClient {
  return {
    read: vi.fn().mockResolvedValue(readResult),
    write: vi.fn().mockResolvedValue({}),
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    log: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(true),
  } as unknown as MuninClient;
}

function mockBotApi(): Api & { sendMessage: ReturnType<typeof vi.fn> } {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as Api & { sendMessage: ReturnType<typeof vi.fn> };
  return api;
}

// ---------------------------------------------------------------------------
// decideAlert — pure function tests
// ---------------------------------------------------------------------------

describe("decideAlert — pure function", () => {
  describe("healthy status", () => {
    it("returns no message and stable state when no prior alert", () => {
      const prev: AlertState = { lastAlertedStatus: null, lastErrorAt: null };
      const { message, nextState } = decideAlert(prev, makeEntry({ status: "healthy" }));
      expect(message).toBeNull();
      expect(nextState.lastAlertedStatus).toBe("healthy");
    });

    it("returns no message when already healthy", () => {
      const prev: AlertState = { lastAlertedStatus: "healthy", lastErrorAt: null };
      const { message } = decideAlert(prev, makeEntry({ status: "healthy" }));
      expect(message).toBeNull();
    });

    it("sends recovery message when previously alerted on 'tripped'", () => {
      const prev: AlertState = {
        lastAlertedStatus: "tripped",
        lastErrorAt: "2026-01-01T00:00:00.000Z",
      };
      const { message, nextState } = decideAlert(prev, makeEntry({ status: "healthy" }));
      expect(message).toMatch(/recovered/i);
      expect(nextState.lastAlertedStatus).toBe("healthy");
      expect(nextState.lastErrorAt).toBeNull();
    });

    it("sends recovery message when previously alerted on 'failing'", () => {
      const prev: AlertState = {
        lastAlertedStatus: "failing",
        lastErrorAt: "2026-01-01T00:00:00.000Z",
      };
      const { message } = decideAlert(prev, makeEntry({ status: "healthy" }));
      expect(message).toMatch(/recovered/i);
    });
  });

  describe("failing status", () => {
    it("sends warning on first failing event from unknown state", () => {
      const { message, nextState } = decideAlert(
        noAlert,
        makeEntry({ status: "failing", failures: 2, max_failures: 5 })
      );
      expect(message).not.toBeNull();
      expect(message).toMatch(/failing/i);
      expect(message).toMatch(/2\/5/);
      expect(nextState.lastAlertedStatus).toBe("failing");
    });

    it("sends warning on transition from healthy (no prior alert)", () => {
      const prev: AlertState = { lastAlertedStatus: "healthy", lastErrorAt: null };
      const { message } = decideAlert(
        prev,
        makeEntry({
          status: "failing",
          failures: 1,
          max_failures: 5,
          last_error: "timeout",
          last_error_at: "2026-01-01T01:00:00.000Z",
        })
      );
      expect(message).not.toBeNull();
      expect(message).toMatch(/failing/i);
      expect(message).toMatch(/timeout/);
    });

    it("does NOT resend for the same failing incident", () => {
      const prev: AlertState = {
        lastAlertedStatus: "failing",
        lastErrorAt: "2026-01-01T00:00:00.000Z",
      };
      const { message } = decideAlert(
        prev,
        makeEntry({
          status: "failing",
          failures: 3,
          max_failures: 5,
          last_error_at: "2026-01-01T00:00:00.000Z",
        })
      );
      expect(message).toBeNull();
    });

    it("resends if new last_error_at after recovery", () => {
      // Simulates: trip → healthy → trip again with a new error_at
      const prev: AlertState = {
        lastAlertedStatus: "healthy", // recovered previously
        lastErrorAt: null,
      };
      const { message } = decideAlert(
        prev,
        makeEntry({
          status: "failing",
          failures: 2,
          max_failures: 5,
          last_error_at: "2026-01-02T00:00:00.000Z",
        })
      );
      expect(message).not.toBeNull();
      expect(message).toMatch(/failing/i);
    });
  });

  describe("tripped status", () => {
    it("sends alert with failure counts on first trip", () => {
      const { message, nextState } = decideAlert(
        noAlert,
        makeEntry({
          status: "tripped",
          failures: 5,
          max_failures: 5,
          last_error: "OpenRouter API error 401",
          last_error_at: "2026-01-01T00:00:00.000Z",
        })
      );
      expect(message).not.toBeNull();
      expect(message).toMatch(/TRIPPED/);
      expect(message).toMatch(/5\/5/);
      expect(message).toMatch(/OpenRouter API error 401/);
      expect(message).toMatch(/not drain/i);
      expect(nextState.lastAlertedStatus).toBe("tripped");
      expect(nextState.lastErrorAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("does NOT resend for the same tripped incident", () => {
      const prev: AlertState = {
        lastAlertedStatus: "tripped",
        lastErrorAt: "2026-01-01T00:00:00.000Z",
      };
      const { message } = decideAlert(
        prev,
        makeEntry({
          status: "tripped",
          failures: 5,
          max_failures: 5,
          last_error_at: "2026-01-01T00:00:00.000Z",
        })
      );
      expect(message).toBeNull();
    });

    it("resends if re-trips after recovery with new last_error_at", () => {
      const prev: AlertState = {
        lastAlertedStatus: "healthy",
        lastErrorAt: null,
      };
      const { message } = decideAlert(
        prev,
        makeEntry({
          status: "tripped",
          failures: 5,
          max_failures: 5,
          last_error_at: "2026-01-03T00:00:00.000Z",
        })
      );
      expect(message).not.toBeNull();
      expect(message).toMatch(/TRIPPED/);
    });
  });

  describe("full sequence: healthy → failing → tripped → healthy → tripped", () => {
    it("sends exactly the right messages in order", () => {
      const sequence: ConsolidationHealthEntry[] = [
        makeEntry({ status: "healthy" }),
        makeEntry({ status: "failing", failures: 2, max_failures: 5, last_error: "err1", last_error_at: "T1" }),
        makeEntry({ status: "tripped", failures: 5, max_failures: 5, last_error: "err1", last_error_at: "T1" }),
        makeEntry({ status: "tripped", failures: 5, max_failures: 5, last_error: "err1", last_error_at: "T1" }), // duplicate
        makeEntry({ status: "healthy" }),
        makeEntry({ status: "healthy" }), // duplicate
        makeEntry({ status: "tripped", failures: 5, max_failures: 5, last_error: "err2", last_error_at: "T2" }), // new incident
      ];

      const messages: string[] = [];
      let state: AlertState = { lastAlertedStatus: null, lastErrorAt: null };

      for (const entry of sequence) {
        const { message, nextState } = decideAlert(state, entry);
        if (message !== null) messages.push(message);
        state = nextState;
      }

      expect(messages).toHaveLength(4); // failing, tripped, recovered, re-tripped
      expect(messages[0]).toMatch(/failing/i);
      expect(messages[1]).toMatch(/TRIPPED/);
      expect(messages[2]).toMatch(/recovered/i);
      expect(messages[3]).toMatch(/TRIPPED/);
      expect(messages[3]).toMatch(/err2/);
    });
  });
});

// ---------------------------------------------------------------------------
// ConsolidationHealthPoller — integration-level tests (mocked I/O)
// ---------------------------------------------------------------------------

describe("ConsolidationHealthPoller", () => {
  let poller: ConsolidationHealthPoller;

  afterEach(() => {
    poller?.stop();
  });

  it("sends no message when Munin entry is absent", async () => {
    const munin = mockMunin(null);
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await poller.poll();

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not crash and does not send when Munin read throws", async () => {
    const munin = {
      read: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as unknown as MuninClient;
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends alert when status is 'tripped'", async () => {
    const entry: ConsolidationHealthEntry = {
      status: "tripped",
      failures: 5,
      max_failures: 5,
      last_error: "401 Unauthorized",
      last_error_at: "2026-01-01T00:00:00.000Z",
    };
    const munin = mockMunin({
      id: "1",
      namespace: "meta/system-health",
      key: "consolidation",
      content: JSON.stringify(entry),
      tags: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      found: true,
    });
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await poller.poll();

    expect(api.sendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = api.sendMessage.mock.calls[0] as [number, string];
    expect(chatId).toBe(12345678);
    expect(text).toMatch(/TRIPPED/);
    expect(text).toMatch(/401 Unauthorized/);
  });

  it("does not resend for same tripped incident on subsequent polls", async () => {
    const entry: ConsolidationHealthEntry = {
      status: "tripped",
      failures: 5,
      max_failures: 5,
      last_error: "err",
      last_error_at: "2026-01-01T00:00:00.000Z",
    };
    const munin = mockMunin({
      id: "1",
      namespace: "meta/system-health",
      key: "consolidation",
      content: JSON.stringify(entry),
      tags: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      found: true,
    });
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("sends recovery message after tripped → healthy", async () => {
    const trippedEntry: ConsolidationHealthEntry = {
      status: "tripped",
      failures: 5,
      max_failures: 5,
      last_error_at: "2026-01-01T00:00:00.000Z",
    };
    const healthyEntry: ConsolidationHealthEntry = {
      status: "healthy",
      failures: 0,
      max_failures: 5,
    };

    const readFn = vi.fn();
    readFn
      .mockResolvedValueOnce({
        id: "1",
        namespace: "meta/system-health",
        key: "consolidation",
        content: JSON.stringify(trippedEntry),
        tags: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        found: true,
      })
      .mockResolvedValueOnce({
        id: "1",
        namespace: "meta/system-health",
        key: "consolidation",
        content: JSON.stringify(healthyEntry),
        tags: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T01:00:00.000Z",
        found: true,
      });

    const munin = { read: readFn } as unknown as MuninClient;
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await poller.poll(); // tripped alert
    await poller.poll(); // recovery

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const firstMsg = api.sendMessage.mock.calls[0][1] as string;
    const secondMsg = api.sendMessage.mock.calls[1][1] as string;
    expect(firstMsg).toMatch(/TRIPPED/);
    expect(secondMsg).toMatch(/recovered/i);
  });

  it("does not crash when entry content is invalid JSON", async () => {
    const munin = mockMunin({
      id: "1",
      namespace: "meta/system-health",
      key: "consolidation",
      content: "not-json",
      tags: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      found: true,
    });
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("uses allowedUsers[0] as the Telegram chat ID", async () => {
    const entry: ConsolidationHealthEntry = {
      status: "failing",
      failures: 2,
      max_failures: 5,
    };
    const munin = mockMunin({
      id: "1",
      namespace: "meta/system-health",
      key: "consolidation",
      content: JSON.stringify(entry),
      tags: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      found: true,
    });
    const api = mockBotApi();

    poller = new ConsolidationHealthPoller(munin, api, 60000);
    await poller.poll();

    expect(api.sendMessage).toHaveBeenCalledOnce();
    const chatId = api.sendMessage.mock.calls[0][0] as number;
    expect(chatId).toBe(12345678); // from mocked config
  });
});
