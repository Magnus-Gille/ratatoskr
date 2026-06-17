import { describe, it, expect, vi } from "vitest";

// bot.ts imports config (which reads env vars) and various modules — mock them
// so we can import the pure helper without side effects.
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
    instanceId: "default",
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

import { buildReplyContext } from "../src/bot.js";

describe("buildReplyContext", () => {
  it("returns null when repliedTo is null and tracked is null", () => {
    expect(buildReplyContext(null, null)).toBeNull();
  });

  it("returns null when repliedTo is undefined and tracked is null", () => {
    expect(buildReplyContext(undefined, null)).toBeNull();
  });

  it("returns null when repliedTo has no text/caption and tracked is null", () => {
    // media-only message (no text, no caption)
    expect(buildReplyContext({ message_id: 42 }, null)).toBeNull();
  });

  it("builds context from Telegram text alone (untracked proactive alert)", () => {
    const alertText =
      "🔴 Munin consolidation worker TRIPPED — last heartbeat 47 min ago. Check huginmunin.";
    const result = buildReplyContext(
      { message_id: 99, text: alertText },
      null
    );
    expect(result).not.toBeNull();
    expect(result!.replyToText).toBe(alertText);
    expect(result!.type).toBe("status");
  });

  it("builds context from caption when text is absent (photo reply)", () => {
    const caption = "Fix this layout bug";
    const result = buildReplyContext(
      { message_id: 77, caption },
      null
    );
    expect(result).not.toBeNull();
    expect(result!.replyToText).toBe(caption);
  });

  it("merges tracked context with Telegram text, overlaying replyToText", () => {
    const tracked = {
      type: "result" as const,
      taskId: "fix-navbar",
      snippet: "The build succeeded.",
      timestamp: 1000,
    };
    const repliedText = "The build succeeded — full output here.";
    const result = buildReplyContext(
      { message_id: 55, text: repliedText },
      tracked
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("result");
    expect(result!.taskId).toBe("fix-navbar");
    expect(result!.snippet).toBe("The build succeeded.");
    expect(result!.replyToText).toBe(repliedText);
  });

  it("falls through to tracked context when Telegram has no text or caption", () => {
    const tracked = {
      type: "clarify" as const,
      snippet: "Which repo?",
      timestamp: 2000,
    };
    const result = buildReplyContext(
      { message_id: 33 }, // no text, no caption
      tracked
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("clarify");
    // replyToText should be undefined since there was no text
    expect(result!.replyToText).toBeUndefined();
  });

  it("truncates replyToText to 1000 chars", () => {
    const longText = "x".repeat(1500);
    const result = buildReplyContext(
      { message_id: 11, text: longText },
      null
    );
    expect(result).not.toBeNull();
    expect(result!.replyToText!.length).toBe(1000);
  });
});
