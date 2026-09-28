import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAnthropicCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

vi.mock("../src/config.js", () => ({
  config: {
    llmProvider: "openai-compatible",
    llmBaseUrl: "http://localhost:1234/v1",
    llmApiKey: "primary-key",
    llmModel: "primary-model",
    llmFallbackBaseUrl: "http://localhost:2345/v1",
    llmFallbackApiKey: "fallback-key",
    llmFallbackModel: "fallback-model",
    llmPrimaryTimeoutMs: 20,
    llmFallbackTimeoutMs: 50,
    anthropicApiKey: "anthropic-key",
    conciergeModel: "anthropic-model",
  },
  isLocalHost: (url: string) => url.includes("localhost"),
}));

import { config } from "../src/config.js";
import { callLLM } from "../src/llm-adapter.js";

const request = {
  model: "requested-model",
  system: "Be concise.",
  messages: [{ role: "user" as const, content: "hello" }],
  max_tokens: 32,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAI-compatible LLM adapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    config.llmProvider = "openai-compatible";
    mockAnthropicCreate.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    config.llmProvider = "openai-compatible";
    vi.unstubAllGlobals();
  });

  it("translates a plain text request and response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "hello back" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })
    );

    const result = await callLLM(request);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer primary-key",
    });
    expect(body).toEqual({
      model: "requested-model",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hello" },
      ],
      max_tokens: 32,
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "hello back" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it("calls Anthropic and normalizes its response through the adapter", async () => {
    config.llmProvider = "anthropic";
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "anthropic reply" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4 },
    });
    const result = await callLLM(request);

    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "requested-model",
        messages: request.messages,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "anthropic reply" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4 },
    });
  });

  it("maps attachments when an Anthropic outage falls back to OpenAI-compatible", async () => {
    config.llmProvider = "anthropic";
    mockAnthropicCreate.mockRejectedValue(new Error("Anthropic unavailable"));
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "fallback vision result" },
            finish_reason: "stop",
          },
        ],
      })
    );

    const result = await callLLM({
      ...request,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "document text",
              },
            },
            { type: "text", text: "describe these" },
          ],
        },
      ],
    });

    expect(result.content).toEqual([
      { type: "text", text: "fallback vision result" },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).messages[1].content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,image-data" },
      },
      { type: "text", text: "document text" },
      { type: "text", text: "describe these" },
    ]);
  });

  it("preserves Anthropic text blocks across an OpenAI-compatible round trip", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "hello" },
                { type: "text", text: " back" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      })
    );

    const result = await callLLM({
      ...request,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: " there" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "earlier" },
            { type: "text", text: " answer" },
          ],
        },
      ],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "hello there" },
      { role: "assistant", content: "earlier answer" },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "hello back" }]);
  });

  it("supports a complete tool-call and tool-result round trip", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"id":7}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "The answer is ready." },
              finish_reason: "stop",
            },
          ],
        })
      );

    const first = await callLLM(
      {
        ...request,
        tools: [
          {
            name: "lookup",
            description: "Look up a record.",
            input_schema: { type: "object", properties: { id: { type: "number" } } },
          },
        ],
      },
    );

    const second = await callLLM(
      {
        ...request,
        messages: [
          { role: "user", content: "Find record 7." },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "Record 7 found.",
              },
            ],
          },
        ],
      },
    );

    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)
    );
    expect(first).toEqual({
      content: [
        { type: "tool_use", id: "call-1", name: "lookup", input: { id: 7 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(secondBody.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Find record 7." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"id":7}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "Record 7 found." },
    ]);
    expect(second.content).toEqual([{ type: "text", text: "The answer is ready." }]);
  });

  it("turns malformed tool arguments into a clear tool input error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-bad",
                  type: "function",
                  function: { name: "lookup", arguments: "not-json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    );

    const result = await callLLM(request);

    expect(result.content[0]).toMatchObject({
      type: "tool_use",
      id: "call-bad",
      name: "lookup",
      input: { error: expect.stringContaining("Malformed tool arguments") },
    });
  });

  it.each(["null", "[]", '"text"'])(
    "rejects non-object JSON tool arguments clearly (%s)",
    async (argumentsJson) => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call-shape",
                    type: "function",
                    function: { name: "lookup", arguments: argumentsJson },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
      );

      const result = await callLLM(request);

      expect(result.content[0]).toMatchObject({
        type: "tool_use",
        input: { error: expect.stringContaining("expected a JSON object") },
      });
    }
  );

  it("errors clearly instead of silently dropping unsupported content", async () => {
    await expect(
      callLLM({
        ...request,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", data: "redacted" } },
              { type: "text", text: "describe this" },
            ],
          },
        ],
      })
    ).rejects.toThrow("Unsupported non-text LLM content");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back after a non-2xx primary response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            { message: { role: "assistant", content: "fallback text" }, finish_reason: "stop" },
          ],
        })
      );

    const onServed = vi.fn();
    const result = await callLLM(request, { onServed });

    expect(result.content).toEqual([{ type: "text", text: "fallback text" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
      "http://localhost:2345/v1/chat/completions"
    );
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).model).toBe(
      "fallback-model"
    );
    expect(onServed).toHaveBeenCalledWith({
      provider: "openai-compatible",
      model: "fallback-model",
      fallback: true,
    });
  });

  it("falls back after a primary network error", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            { message: { role: "assistant", content: "network fallback" }, finish_reason: "stop" },
          ],
        })
      );

    const result = await callLLM(request);

    expect(result.content).toEqual([{ type: "text", text: "network fallback" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes a response-body AbortError and falls back", async () => {
    const abortError = new Error("response body was aborted");
    abortError.name = "AbortError";
    const abortedResponse = {
      ok: true,
      json: vi.fn().mockRejectedValue(abortError),
    } as unknown as Response;

    fetchMock
      .mockResolvedValueOnce(abortedResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "body fallback" },
              finish_reason: "stop",
            },
          ],
        })
      );

    const result = await callLLM(request);

    expect(result.content).toEqual([{ type: "text", text: "body fallback" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back after a real response JSON parse failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")),
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          { message: { role: "assistant", content: "should not serve" } },
        ],
      })
    );

    await expect(callLLM(request)).rejects.toThrow("not valid JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back after a primary timeout", async () => {
    fetchMock
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            { message: { role: "assistant", content: "after timeout" }, finish_reason: "stop" },
          ],
        })
      );

    const result = await callLLM(request, {
      fetchImpl: fetchMock,
      primaryTimeoutMs: 1,
    });

    expect(result.content).toEqual([{ type: "text", text: "after timeout" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a bounded error when both primary and fallback fail", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("primary network details"))
      .mockResolvedValueOnce(new Response("fallback unavailable", { status: 502 }));

    await expect(callLLM(request)).rejects.toThrow(
      "LLM request failed"
    );
  });
});
