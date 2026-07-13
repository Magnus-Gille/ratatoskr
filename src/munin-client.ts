/**
 * Munin Memory HTTP client.
 * Talks to Munin's JSON-RPC 2.0 API over HTTP (stateless mode — no handshake needed).
 */

import { AbortContext, runtimeAbort } from "./abort-context.js";

export const DEFAULT_MUNIN_REQUEST_TIMEOUT_MS = 10_000;

export interface MuninEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MuninQueryResult {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: string;
  content_preview: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MuninClientConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  abortContext?: AbortContext;
}

let rpcId = 0;

export class MuninClient {
  private baseUrl: string;
  private apiKey: string;
  private requestTimeoutMs: number;
  private fetchImpl: typeof fetch;
  private abortContext: AbortContext;

  constructor(config: MuninClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_MUNIN_REQUEST_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.abortContext = config.abortContext ?? runtimeAbort;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const signal = this.abortContext.deadline(this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Munin ${res.status}: ${text}`);
      }

      // Parse SSE response — extract the last data line with a JSON-RPC result
      const text = await res.text();
      const lines = text.split("\n");
      let lastData = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          lastData = line.slice(6);
        }
      }

      if (!lastData) {
        // Maybe it's a plain JSON response
        const parsed = JSON.parse(text);
        if (parsed.result?.content?.[0]?.text) {
          return JSON.parse(parsed.result.content[0].text);
        }
        return parsed;
      }

      const rpc = JSON.parse(lastData);
      if (rpc.error) {
        throw new Error(`Munin RPC error: ${JSON.stringify(rpc.error)}`);
      }
      const content = rpc.result?.content?.[0]?.text;
      if (content) {
        return JSON.parse(content);
      }
      return rpc.result;
    } catch (err) {
      throw this.abortContext.normalize(
        err,
        signal,
        "Munin request",
        this.requestTimeoutMs
      );
    }
  }

  async read(
    namespace: string,
    key: string
  ): Promise<(MuninEntry & { found: true }) | null> {
    const result = (await this.callTool("memory_read", {
      namespace,
      key,
    })) as { found: boolean } & MuninEntry;
    return result.found ? (result as MuninEntry & { found: true }) : null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string
  ): Promise<unknown> {
    const args: Record<string, unknown> = { namespace, key, content };
    if (tags) args.tags = tags;
    if (expectedUpdatedAt) args.expected_updated_at = expectedUpdatedAt;
    return this.callTool("memory_write", args);
  }

  async query(opts: {
    query: string;
    tags?: string[];
    namespace?: string;
    limit?: number;
    entry_type?: string;
  }): Promise<{ results: MuninQueryResult[]; total: number }> {
    const args: Record<string, unknown> = { query: opts.query };
    if (opts.tags) args.tags = opts.tags;
    if (opts.namespace) args.namespace = opts.namespace;
    if (opts.limit) args.limit = opts.limit;
    if (opts.entry_type) args.entry_type = opts.entry_type;
    return (await this.callTool("memory_query", args)) as {
      results: MuninQueryResult[];
      total: number;
    };
  }

  async log(
    namespace: string,
    content: string,
    tags?: string[]
  ): Promise<void> {
    const args: Record<string, unknown> = { namespace, content };
    if (tags) args.tags = tags;
    await this.callTool("memory_log", args);
  }

  async health(): Promise<boolean> {
    const signal = this.abortContext.deadline(this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal });
      return res.ok;
    } catch {
      return false;
    }
  }
}
