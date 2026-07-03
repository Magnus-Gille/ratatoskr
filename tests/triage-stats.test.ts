import { describe, it, expect } from "vitest";
import { TriageStats } from "../src/triage-stats.js";

function meta(overrides: Partial<{ latencyMs: number; inputTokens: number; outputTokens: number }> = {}) {
  return {
    model: "claude-haiku-4-5-20251001",
    latencyMs: 100,
    inputTokens: 50,
    outputTokens: 10,
    ...overrides,
  };
}

describe("TriageStats", () => {
  it("starts with a zeroed snapshot", () => {
    const stats = new TriageStats();
    expect(stats.snapshot()).toEqual({
      total: 0,
      byAction: { ready: 0, clarify: 0, answer: 0 },
      avgLatencyMs: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
    });
  });

  it("counts a single recorded decision", () => {
    const stats = new TriageStats();
    stats.record("ready", meta());
    expect(stats.snapshot()).toEqual({
      total: 1,
      byAction: { ready: 1, clarify: 0, answer: 0 },
      avgLatencyMs: 100,
      avgInputTokens: 50,
      avgOutputTokens: 10,
    });
  });

  it("tallies multiple actions independently", () => {
    const stats = new TriageStats();
    stats.record("ready", meta());
    stats.record("clarify", meta());
    stats.record("answer", meta());
    stats.record("answer", meta());
    const snap = stats.snapshot();
    expect(snap.total).toBe(4);
    expect(snap.byAction).toEqual({ ready: 1, clarify: 1, answer: 2 });
  });

  it("averages latency and tokens across decisions, rounded", () => {
    const stats = new TriageStats();
    stats.record("ready", meta({ latencyMs: 100, inputTokens: 50, outputTokens: 10 }));
    stats.record("answer", meta({ latencyMs: 201, inputTokens: 51, outputTokens: 11 }));
    const snap = stats.snapshot();
    expect(snap.avgLatencyMs).toBe(Math.round((100 + 201) / 2));
    expect(snap.avgInputTokens).toBe(Math.round((50 + 51) / 2));
    expect(snap.avgOutputTokens).toBe(Math.round((10 + 11) / 2));
  });
});
