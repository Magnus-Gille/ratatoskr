import { describe, expect, it } from "vitest";
import {
  AbortContext,
  RequestTimeoutError,
  ServiceShutdownError,
} from "../src/abort-context.js";

describe("AbortContext", () => {
  it("classifies a deadline abort as a request timeout", async () => {
    const context = new AbortContext();
    const signal = context.deadline(5);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    );

    const normalized = context.normalize(
      signal.reason,
      signal,
      "test request",
      5
    );
    expect(normalized).toBeInstanceOf(RequestTimeoutError);
    expect((normalized as Error).message).toContain("timed out after 5ms");
  });

  it("aborts all in-flight deadline signals immediately during shutdown", () => {
    const context = new AbortContext();
    const first = context.deadline(60_000);
    const second = context.deadline(60_000);

    context.abort();

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(
      context.normalize(first.reason, first, "test request", 60_000)
    ).toBeInstanceOf(ServiceShutdownError);
  });
});
