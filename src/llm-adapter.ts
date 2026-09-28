import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
  AbortContext,
  RequestTimeoutError,
  ServiceShutdownError,
} from "./abort-context.js";

export type LLMProvider = "anthropic" | "openai-compatible";

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type LLMResponseBlock = LLMTextBlock | LLMToolUseBlock;

export interface LLMMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface LLMTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  max_tokens?: number;
}

export interface LLMResponse {
  content: LLMResponseBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: { input_tokens: number; output_tokens: number };
}

export interface LLMCallOptions {
  fetchImpl?: typeof fetch;
  abortContext?: AbortContext;
  signal?: AbortSignal;
  primaryTimeoutMs?: number;
  fallbackTimeoutMs?: number;
  onServed?: (info: {
    provider: LLMProvider;
    model: string;
    fallback: boolean;
  }) => void;
}

class LLMTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LLMTransportError";
  }
}

class LLMConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigurationError";
  }
}

type ProviderEndpoint = {
  provider: LLMProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
};

function providerFromConfig(): LLMProvider {
  return config.llmProvider === "openai-compatible"
    ? "openai-compatible"
    : "anthropic";
}

function makeSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  abortContext: AbortContext | undefined
): AbortSignal {
  const timeoutSignal = abortContext
    ? abortContext.deadline(timeoutMs)
    : AbortSignal.timeout(timeoutMs);
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}

function normalizeTransportError(
  err: unknown,
  signal: AbortSignal,
  abortContext: AbortContext | undefined,
  label: string,
  timeoutMs: number
): Error {
  if (abortContext) {
    const normalized = abortContext.normalize(err, signal, label, timeoutMs);
    if (normalized instanceof ServiceShutdownError) return normalized;
    if (normalized instanceof RequestTimeoutError) return normalized;
  }
  if (
    (err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")) ||
    signal.aborted
  ) {
    return new RequestTimeoutError(label, timeoutMs, {
      cause: err instanceof Error ? err : undefined,
    });
  }
  return new LLMTransportError("LLM request failed", {
    cause: err instanceof Error ? err : undefined,
  });
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
}

function toolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textFromContent(content);
  return JSON.stringify(content) ?? String(content);
}

function translateOpenAIMessage(message: LLMMessage): Record<string, unknown>[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw new LLMConfigurationError("Unsupported LLM message content");
  }

  const textBlocks = message.content.filter(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
  );
  const toolUseBlocks = message.content.filter(
    (block): block is LLMToolUseBlock =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use"
  );
  const toolResultBlocks = message.content.filter(
    (block): block is LLMToolResultBlock =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_result"
  );
  const knownCount =
    textBlocks.length + toolUseBlocks.length + toolResultBlocks.length;
  if (knownCount !== message.content.length) {
    throw new LLMConfigurationError(
      "Unsupported non-text LLM content for openai-compatible provider"
    );
  }

  if (toolResultBlocks.length > 0) {
    if (message.role !== "user" || toolUseBlocks.length > 0) {
      throw new LLMConfigurationError("Invalid LLM tool result message");
    }
    return toolResultBlocks.map((block) => ({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: toolResultContent(block.content),
    }));
  }

  if (toolUseBlocks.length > 0) {
    if (message.role !== "assistant") {
      throw new LLMConfigurationError("LLM tool use blocks must be assistant content");
    }
    return [
      {
        role: "assistant",
        content: textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("") : null,
        tool_calls: toolUseBlocks.map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input) ?? "{}",
          },
        })),
      },
    ];
  }

  if (message.role !== "user") {
    return [{ role: message.role, content: textBlocks.map((block) => block.text).join("") }];
  }
  return [{ role: message.role, content: textBlocks.map((block) => block.text).join("") }];
}

function translateOpenAITool(tool: LLMTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  };
}

function parseToolArguments(raw: unknown, name: string): unknown {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    return {
      error: `Malformed tool arguments for ${name}: expected a JSON object`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        error: `Malformed tool arguments for ${name}: expected a JSON object`,
      };
    }
    return parsed;
  } catch {
    return { error: `Malformed tool arguments for ${name}: invalid JSON` };
  }
}

function mapStopReason(reason: unknown): LLMResponse["stop_reason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function parseOpenAIResponse(body: unknown): LLMResponse {
  if (typeof body !== "object" || body === null) {
    throw new LLMConfigurationError("LLM response was not an object");
  }
  const choice = (body as { choices?: unknown[] }).choices?.[0];
  if (typeof choice !== "object" || choice === null) {
    throw new LLMConfigurationError("LLM response did not contain a choice");
  }
  const message = (choice as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw new LLMConfigurationError("LLM response did not contain a message");
  }

  const content: LLMResponseBlock[] = [];
  const messageContent = (message as { content?: unknown }).content;
  if (typeof messageContent === "string" && messageContent) {
    content.push({ type: "text", text: messageContent });
  } else if (Array.isArray(messageContent)) {
    const text = textFromContent(messageContent);
    if (text) content.push({ type: "text", text });
  }

  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      if (typeof toolCall !== "object" || toolCall === null) {
        throw new LLMConfigurationError("LLM response contained an invalid tool call");
      }
      const fn = (toolCall as { function?: unknown }).function;
      const id = (toolCall as { id?: unknown }).id;
      const name = fn && typeof fn === "object" ? (fn as { name?: unknown }).name : undefined;
      if (typeof id !== "string" || typeof name !== "string") {
        throw new LLMConfigurationError("LLM response contained an incomplete tool call");
      }
      const rawArguments = fn && typeof fn === "object"
        ? (fn as { arguments?: unknown }).arguments
        : undefined;
      content.push({
        type: "tool_use",
        id,
        name,
        input: parseToolArguments(rawArguments, name),
      });
    }
  }

  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    content,
    stop_reason: mapStopReason((choice as { finish_reason?: unknown }).finish_reason),
    usage: {
      input_tokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens:
        typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
  };
}

async function callOpenAICompatible(
  params: LLMRequest,
  endpoint: ProviderEndpoint,
  options: LLMCallOptions
): Promise<LLMResponse> {
  if (!endpoint.baseUrl) {
    throw new LLMConfigurationError("LLM_BASE_URL is required for openai-compatible provider");
  }
  const messages = params.messages.flatMap(translateOpenAIMessage);
  const body: Record<string, unknown> = {
    model: endpoint.model || params.model,
    messages: [
      ...(params.system !== undefined
        ? [{ role: "system", content: params.system }]
        : []),
      ...messages,
    ],
  };
  if (params.tools?.length) body.tools = params.tools.map(translateOpenAITool);
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;

  const signal = makeSignal(
    options.signal,
    endpoint.timeoutMs,
    options.abortContext
  );
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(chatCompletionsUrl(endpoint.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw normalizeTransportError(
      err,
      signal,
      options.abortContext,
      "LLM request",
      endpoint.timeoutMs
    );
  }
  if (!response.ok) throw new LLMTransportError("LLM request failed");
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new LLMConfigurationError("LLM response was not valid JSON");
  }
  return parseOpenAIResponse(responseBody);
}

function normalizeAnthropicResponse(response: Anthropic.Message): LLMResponse {
  const content: LLMResponseBlock[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    content,
    stop_reason:
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn",
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

async function callAnthropic(
  params: LLMRequest,
  endpoint: ProviderEndpoint,
  options: LLMCallOptions
): Promise<LLMResponse> {
  const signal = makeSignal(
    options.signal,
    endpoint.timeoutMs,
    options.abortContext
  );
  const client = new Anthropic({ apiKey: endpoint.apiKey || "" });
  try {
    const response = await client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      { signal }
    );
    return normalizeAnthropicResponse(response);
  } catch (err) {
    const normalized = normalizeTransportError(
      err,
      signal,
      options.abortContext,
      "LLM request",
      endpoint.timeoutMs
    );
    if (normalized instanceof ServiceShutdownError) throw normalized;
    throw normalized;
  }
}

async function callProvider(
  params: LLMRequest,
  endpoint: ProviderEndpoint,
  options: LLMCallOptions
): Promise<LLMResponse> {
  return endpoint.provider === "anthropic"
    ? callAnthropic(params, endpoint, options)
    : callOpenAICompatible(params, endpoint, options);
}

/**
 * Call the configured LLM while exposing the Anthropic-shaped request and
 * response used by the concierge. The optional fallback is an
 * OpenAI-compatible endpoint and is only attempted for transport failures.
 */
export async function callLLM(
  params: LLMRequest,
  options: LLMCallOptions = {}
): Promise<LLMResponse> {
  const provider = providerFromConfig();
  const primaryTimeoutMs =
    options.primaryTimeoutMs ?? config.llmPrimaryTimeoutMs ?? 20000;
  const fallbackTimeoutMs =
    options.fallbackTimeoutMs ?? config.llmFallbackTimeoutMs ?? 60000;
  const primary: ProviderEndpoint = {
    provider,
    baseUrl: config.llmBaseUrl,
    apiKey: provider === "anthropic" ? config.anthropicApiKey : config.llmApiKey,
    model: params.model,
    timeoutMs: primaryTimeoutMs,
  };

  try {
    const response = await callProvider(params, primary, options);
    options.onServed?.({
      provider: primary.provider,
      model: primary.model || params.model,
      fallback: false,
    });
    return response;
  } catch (primaryError) {
    if (
      primaryError instanceof ServiceShutdownError ||
      !(primaryError instanceof LLMTransportError ||
        primaryError instanceof RequestTimeoutError)
    ) {
      throw primaryError;
    }
    if (!config.llmFallbackBaseUrl) throw primaryError;

    const fallback: ProviderEndpoint = {
      provider: "openai-compatible",
      baseUrl: config.llmFallbackBaseUrl,
      apiKey: config.llmFallbackApiKey,
      model: config.llmFallbackModel || params.model,
      timeoutMs: fallbackTimeoutMs,
    };
    try {
      const response = await callProvider(params, fallback, options);
      options.onServed?.({
        provider: fallback.provider,
        model: fallback.model || params.model,
        fallback: true,
      });
      return response;
    } catch (fallbackError) {
      if (fallbackError instanceof ServiceShutdownError) throw fallbackError;
      throw new LLMTransportError("LLM request failed on primary and fallback", {
        cause: fallbackError,
      });
    }
  }
}
