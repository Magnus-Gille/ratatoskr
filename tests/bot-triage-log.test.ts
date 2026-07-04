import { describe, it, expect, vi } from "vitest";

// bot.ts imports config (which reads env vars) and various modules — mock them
// so we can import the pure helper without side effects. Mirrors
// bot-reply-context.test.ts's mocking approach.
vi.mock("../src/config.js", () => ({
  config: {
    telegramBotToken: "test-token",
    allowedUsers: ["12345"],
    anthropicApiKey: "test-key",
    conciergeModel: "claude-haiku-4-5-20251001",
    muninUrl: "http://localhost:3030",
    muninApiKey: "test-munin-key",
    pollIntervalMs: 30000,
    maxPollDurationMs: 7200000,
    instanceId: "huginmunin",
    reposBasePath: "/home/magnus/repos",
  },
}));

vi.mock("../src/munin-client.js", () => ({
  MuninClient: vi.fn(),
}));

vi.mock("../src/result-poller.js", () => ({
  ResultPoller: vi.fn(),
}));

vi.mock("../src/concierge.js", () => ({
  gatherContext: vi.fn(),
  triage: vi.fn(),
  summarizeResult: vi.fn(),
}));

vi.mock("../src/task-writer.js", () => ({
  submitTask: vi.fn(),
}));

vi.mock("../src/telegram-util.js", () => ({
  formatResultWithSummary: vi.fn(),
}));

vi.mock("../src/telegram-file.js", () => ({
  downloadPhoto: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    catch: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
  })),
  Context: vi.fn(),
}));

import { buildTriageLogEntry, recordTriageEvidence } from "../src/bot.js";
import { TriageStats } from "../src/triage-stats.js";
import type { MuninClient } from "../src/munin-client.js";
import type { TriageResult } from "../src/concierge.js";

describe("buildTriageLogEntry", () => {
  it("builds a Munin log entry with action, model, latency, and tokens", () => {
    const entry = buildTriageLogEntry("ready", {
      model: "claude-haiku-4-5-20251001",
      latencyMs: 842,
      inputTokens: 310,
      outputTokens: 64,
    });

    expect(entry.namespace).toBe("ratatoskr/triage");
    const content = JSON.parse(entry.content);
    expect(content).toMatchObject({
      action: "ready",
      model: "claude-haiku-4-5-20251001",
      latencyMs: 842,
      inputTokens: 310,
      outputTokens: 64,
    });
    expect(typeof content.timestamp).toBe("number");
    expect(entry.tags).toEqual(
      expect.arrayContaining(["triage", "action:ready", "instance:huginmunin"])
    );
  });

  it("tags clarify and answer decisions with their own action tag", () => {
    const clarify = buildTriageLogEntry("clarify", {
      model: "m",
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(clarify.tags).toContain("action:clarify");

    const answer = buildTriageLogEntry("answer", {
      model: "m",
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(answer.tags).toContain("action:answer");
  });
});

describe("recordTriageEvidence", () => {
  function fakeResult(): TriageResult {
    return {
      action: "answer",
      reply: "hi",
      meta: { model: "m", latencyMs: 1, inputTokens: 1, outputTokens: 1 },
    };
  }

  it("records into TriageStats synchronously, before munin.log() settles", () => {
    const stats = new TriageStats();
    const munin = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as MuninClient;

    recordTriageEvidence(munin, stats, fakeResult());

    // Synchronous effect — no await needed to observe it.
    expect(stats.snapshot().total).toBe(1);
    expect(munin.log).toHaveBeenCalledWith(
      "ratatoskr/triage",
      expect.any(String),
      expect.arrayContaining(["triage", "action:answer"])
    );
  });

  it("never throws or produces an unhandled rejection when munin.log() rejects", async () => {
    const stats = new TriageStats();
    const munin = {
      log: vi.fn().mockRejectedValue(new Error("munin down")),
    } as unknown as MuninClient;

    expect(() => recordTriageEvidence(munin, stats, fakeResult())).not.toThrow();
    // Stats recording must not be skipped just because the log call will fail.
    expect(stats.snapshot().total).toBe(1);

    // Let the rejected promise's .catch() settle — proves it's handled, not
    // left dangling as an unhandled rejection that would crash the process.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
