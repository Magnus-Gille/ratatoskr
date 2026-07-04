/**
 * Heimdall self-descriptor for Ratatoskr.
 *
 * Served at GET /heimdall.json for Tier-1 discovery by the Heimdall dashboard.
 * Shape must satisfy Heimdall's validateDescriptor (schema/service/v1).
 *
 * `status` and `metrics` are computed from live process state (issue #27) —
 * not hardcoded — so the descriptor is real competence/health evidence rather
 * than a static placeholder.
 *
 * Keep `version` in sync with package.json when bumping.
 * Route must remain UNAUTHENTICATED — no RATATOSKR_SEND_API_KEY gate.
 */
import type { TriageStatsSnapshot } from "./triage-stats.js";

export interface DescriptorState {
  botConnected: boolean;
  activePolls: number;
  triage: TriageStatsSnapshot;
}

export interface DescriptorMetric {
  key: string;
  label: string;
  unit: string;
  kind: "gauge" | "counter";
  chart: boolean;
  value: number;
}

const BASE_DESCRIPTOR = {
  _schema: "https://heimdall.gille.ai/schema/service/v1",
  service: {
    name: "ratatoskr",
    label: "Ratatoskr",
    namespace: "grimnir",
    instance_id: "huginmunin",
    criticality: "normal",
  },
  kind: "http-service",
  version: "0.1.0",
  deploy: {
    host: "huginmunin",
    systemd_unit: "ratatoskr",
    platform: "bare-metal",
  },
  panels: [],
  alerts: { rules: [], active_count: 0, firing: [] },
  links: {
    self: "/heimdall.json",
    health: "/health",
    repo: "https://github.com/Magnus-Gille/ratatoskr",
  },
  ui: { icon: "bell", category: "infra" },
} as const;

function buildMetrics(state: DescriptorState): DescriptorMetric[] {
  return [
    {
      key: "bot_connected",
      label: "Bot connected",
      unit: "",
      kind: "gauge",
      chart: false,
      value: state.botConnected ? 1 : 0,
    },
    {
      key: "active_polls",
      label: "Active task polls",
      unit: "",
      kind: "gauge",
      chart: true,
      value: state.activePolls,
    },
    {
      key: "triage_decisions_total",
      label: "Triage decisions",
      unit: "",
      kind: "counter",
      chart: true,
      value: state.triage.total,
    },
    {
      key: "triage_avg_latency_ms",
      label: "Triage avg latency",
      unit: "ms",
      kind: "gauge",
      chart: true,
      value: state.triage.avgLatencyMs,
    },
    {
      key: "triage_avg_input_tokens",
      label: "Triage avg input tokens",
      unit: "tokens",
      kind: "gauge",
      chart: false,
      value: state.triage.avgInputTokens,
    },
    {
      key: "triage_avg_output_tokens",
      label: "Triage avg output tokens",
      unit: "tokens",
      kind: "gauge",
      chart: false,
      value: state.triage.avgOutputTokens,
    },
  ];
}

/** Build the full /heimdall.json body from live service state. */
export function buildHeimdallDescriptor(state: DescriptorState) {
  return {
    ...BASE_DESCRIPTOR,
    status: state.botConnected ? "pass" : ("fail" as "pass" | "fail"),
    metrics: buildMetrics(state),
  };
}
