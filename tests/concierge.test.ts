import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK before importing concierge
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Mock config
vi.mock("../src/config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    conciergeModel: "claude-haiku-4-5-20251001",
  },
}));

import { triage, gatherContext } from "../src/concierge.js";
import type { MuninClient } from "../src/munin-client.js";

function mockMunin(): MuninClient {
  return {
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(true),
  } as unknown as MuninClient;
}

describe("concierge", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe("triage", () => {
    it("should return ready when Haiku classifies as ready", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "ready",
              task: {
                prompt: "Fix the navbar CSS bug",
                context: "repo:heimdall",
                timeout: 300,
                title: "fix-navbar-css",
              },
            }),
          },
        ],
      });

      const result = await triage("fix the css bug", [], "No context");
      expect(result.action).toBe("ready");
      if (result.action === "ready") {
        expect(result.task.prompt).toBe("Fix the navbar CSS bug");
        expect(result.task.context).toBe("repo:heimdall");
        expect(result.task.timeout).toBe(300);
      }
    });

    it("should return clarify when Haiku needs more info", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "clarify",
              question: "Which bug? The navbar one or the footer?",
            }),
          },
        ],
      });

      const result = await triage("fix the bug", [], "No context");
      expect(result.action).toBe("clarify");
      if (result.action === "clarify") {
        expect(result.question).toBe(
          "Which bug? The navbar one or the footer?"
        );
      }
    });

    it("should return answer for direct replies", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "answer",
              reply: "There are 2 tasks running right now.",
            }),
          },
        ],
      });

      const result = await triage(
        "what's running?",
        [],
        "## Running tasks\n- task1"
      );
      expect(result.action).toBe("answer");
      if (result.action === "answer") {
        expect(result.reply).toContain("2 tasks");
      }
    });

    it("should handle markdown-fenced JSON from Haiku", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: '```json\n{"action":"answer","reply":"Hello!"}\n```',
          },
        ],
      });

      const result = await triage("hi", [], "No context");
      expect(result.action).toBe("answer");
    });

    it("should inject reply context into the system prompt when provided", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "Resubmitting now." }),
          },
        ],
      });

      await triage("run this again", [], "No context", {
        type: "result",
        taskId: "fix-navbar-css",
        snippet: "That didn't work.\n\nSyntax error on line 42.",
        timestamp: Date.now(),
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("Reply Context");
      expect(callArgs.system).toContain('task "fix-navbar-css"');
      expect(callArgs.system).toContain("That didn't work.");
    });
  });

  describe("gatherContext", () => {
    it("should return context string from Munin queries", async () => {
      const munin = mockMunin();
      const result = await gatherContext(munin);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should include running tasks when available", async () => {
      const munin = mockMunin();
      (munin.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [
          {
            namespace: "tasks/123",
            key: "status",
            content_preview: "Fix the bug in heimdall",
            tags: ["running"],
          },
        ],
        total: 1,
      });

      const result = await gatherContext(munin);
      expect(result).toContain("Running tasks");
    });
  });
});
