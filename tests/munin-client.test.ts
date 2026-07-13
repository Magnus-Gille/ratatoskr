import { describe, expect, it, vi } from "vitest";
import { AbortContext } from "../src/abort-context.js";
import { MuninClient } from "../src/munin-client.js";

function hangingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("MuninClient outbound deadlines", () => {
  it("aborts and classifies a hung RPC request at the configured deadline", async () => {
    const fetchImpl = hangingFetch();
    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "key",
      requestTimeoutMs: 10,
      fetchImpl,
      abortContext: new AbortContext(),
    });

    await expect(client.read("tasks/test", "status")).rejects.toMatchObject({
      name: "RequestTimeoutError",
      message: "Munin request timed out after 10ms",
    });
    const signal = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("aborts a hung RPC immediately when service shutdown starts", async () => {
    const fetchImpl = hangingFetch();
    const abortContext = new AbortContext();
    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "key",
      requestTimeoutMs: 60_000,
      fetchImpl,
      abortContext,
    });

    const pending = client.read("tasks/test", "status");
    abortContext.abort();

    await expect(pending).rejects.toMatchObject({
      name: "ServiceShutdownError",
    });
  });
});
