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

    it("should prefer replyToText over snippet when replyContext has replyToText set (tracker-independent)", async () => {
      // This is the proactive alert case: the alert was never registered in the
      // tracker, so replyContext arrives with replyToText (from Telegram's
      // reply_to_message.text) but no taskId/snippet.
      const alertText =
        "🔴 Munin consolidation worker TRIPPED — last heartbeat 47 min ago. Check huginmunin.";

      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "Restarting the worker now." }),
          },
        ],
      });

      await triage("thats fine, restart it", [], "No context", {
        type: "status",
        replyToText: alertText,
        timestamp: Date.now(),
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("Reply Context");
      // Must contain the full alert text verbatim
      expect(callArgs.system).toContain(alertText);
      // Must NOT fall back to snippet-style reference ("a previous status message")
      // when replyToText is present
      expect(callArgs.system).not.toContain("a previous status message");
    });

    it("should fall back to snippet-based context when replyToText is absent", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "ok" }),
          },
        ],
      });

      await triage("run this again", [], "No context", {
        type: "result",
        taskId: "some-task",
        snippet: "The build succeeded.",
        timestamp: Date.now(),
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("Reply Context");
      expect(callArgs.system).toContain("The build succeeded.");
    });

    it("should send multimodal content when images are provided", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "ready",
              task: {
                prompt: "Fix the error shown in the screenshot: TypeError on line 42",
                context: "repo:myapp",
                timeout: 300,
                title: "fix-type-error",
              },
            }),
          },
        ],
      });

      const images = [
        { base64: "abc123base64data", mediaType: "image/jpeg" },
      ];

      await triage("fix this error", [], "No context", null, images);

      const callArgs = mockCreate.mock.calls[0][0];
      const lastMessage = callArgs.messages[callArgs.messages.length - 1];

      // The last user message should be an array of content blocks
      expect(Array.isArray(lastMessage.content)).toBe(true);

      // First block should be the image
      expect(lastMessage.content[0].type).toBe("image");
      expect(lastMessage.content[0].source.type).toBe("base64");
      expect(lastMessage.content[0].source.media_type).toBe("image/jpeg");
      expect(lastMessage.content[0].source.data).toBe("abc123base64data");

      // Second block should be the text
      expect(lastMessage.content[1].type).toBe("text");
      expect(lastMessage.content[1].text).toBe("fix this error");
    });

    it("should use 'What's in this image?' as fallback text when no caption provided", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "I see a dashboard." }),
          },
        ],
      });

      const images = [{ base64: "imgdata", mediaType: "image/png" }];

      await triage("", [], "No context", null, images);

      const callArgs = mockCreate.mock.calls[0][0];
      const lastMessage = callArgs.messages[callArgs.messages.length - 1];
      const textBlock = lastMessage.content.find(
        (b: { type: string }) => b.type === "text"
      );
      expect(textBlock.text).toBe("What's in this image?");
    });

    it("should send plain string message when no images provided", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "Hello!" }),
          },
        ],
      });

      await triage("hello", [], "No context");

      const callArgs = mockCreate.mock.calls[0][0];
      const lastMessage = callArgs.messages[callArgs.messages.length - 1];
      // No images: content should be the plain string
      expect(typeof lastMessage.content).toBe("string");
      expect(lastMessage.content).toBe("hello");
    });

    it("should attach triage meta (model, latency, tokens) to the result", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "Hello!" }),
          },
        ],
        usage: { input_tokens: 123, output_tokens: 45 },
      });

      const result = await triage("hi", [], "No context");
      expect(result.meta.model).toBe("claude-haiku-4-5-20251001");
      expect(result.meta.inputTokens).toBe(123);
      expect(result.meta.outputTokens).toBe(45);
      expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.meta.latencyMs)).toBe(true);
    });

    it("should default token counts to 0 when the API response has no usage field", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "Hello!" }),
          },
        ],
      });

      const result = await triage("hi", [], "No context");
      expect(result.meta.inputTokens).toBe(0);
      expect(result.meta.outputTokens).toBe(0);
    });

    it("should attach meta to ready and clarify results too", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "clarify",
              question: "Which one?",
            }),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      });

      const result = await triage("fix the bug", [], "No context");
      expect(result.action).toBe("clarify");
      expect(result.meta).toEqual({
        model: "claude-haiku-4-5-20251001",
        latencyMs: expect.any(Number),
        inputTokens: 10,
        outputTokens: 2,
      });
    });

    it("should include image handling instructions in the system prompt", async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ action: "answer", reply: "ok" }),
          },
        ],
      });

      const images = [{ base64: "data", mediaType: "image/jpeg" }];
      await triage("", [], "No context", null, images);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("image");
      expect(callArgs.system).toContain("screenshot");
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
