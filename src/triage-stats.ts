import type { TriageAction, TriageBackend, TriageMeta } from "./concierge.js";

export interface TriageStatsSnapshot {
  total: number;
  byAction: Record<TriageAction, number>;
  /** Which backend served each decision (issue #31/#62). */
  byBackend: Record<TriageBackend, number>;
  /** M5 attempted but Anthropic served — the degraded-path counter (issue #31). */
  m5Fallbacks: number;
  avgLatencyMs: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

/**
 * In-memory (process-lifetime) tally of concierge triage decisions, used to
 * populate real /heimdall.json metrics (issue #27). Resets on restart —
 * that's fine, it's a live gauge, not a durable dataset (Munin's triage log
 * is the durable record).
 */
export class TriageStats {
  private total = 0;
  private byAction: Record<TriageAction, number> = {
    ready: 0,
    clarify: 0,
    answer: 0,
  };
  private byBackend: Record<TriageBackend, number> = {
    m5: 0,
    anthropic: 0,
    "openai-compatible": 0,
  };
  private m5Fallbacks = 0;
  private latencySum = 0;
  private inputTokenSum = 0;
  private outputTokenSum = 0;

  record(action: TriageAction, meta: TriageMeta): void {
    this.total += 1;
    this.byAction[action] += 1;
    this.byBackend[meta.backend] += 1;
    if (meta.fallback) this.m5Fallbacks += 1;
    this.latencySum += meta.latencyMs;
    this.inputTokenSum += meta.inputTokens;
    this.outputTokenSum += meta.outputTokens;
  }

  snapshot(): TriageStatsSnapshot {
    const total = this.total;
    return {
      total,
      byAction: { ...this.byAction },
      byBackend: { ...this.byBackend },
      m5Fallbacks: this.m5Fallbacks,
      avgLatencyMs: total > 0 ? Math.round(this.latencySum / total) : 0,
      avgInputTokens: total > 0 ? Math.round(this.inputTokenSum / total) : 0,
      avgOutputTokens: total > 0 ? Math.round(this.outputTokenSum / total) : 0,
    };
  }
}
