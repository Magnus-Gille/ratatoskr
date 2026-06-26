/**
 * Heimdall self-descriptor for Ratatoskr.
 *
 * Served at GET /heimdall.json for Tier-1 discovery by the Heimdall dashboard.
 * Shape must satisfy Heimdall's validateDescriptor (schema/service/v1).
 *
 * Keep `version` in sync with package.json when bumping.
 * Route must remain UNAUTHENTICATED — no RATATOSKR_SEND_API_KEY gate.
 */
export const HEIMDALL_DESCRIPTOR = {
  _schema: "https://heimdall.gille.ai/schema/service/v1",
  service: {
    name: "ratatoskr",
    label: "Ratatoskr",
    namespace: "grimnir",
    instance_id: "huginmunin",
    criticality: "normal",
  },
  kind: "http-service",
  status: "pass",
  version: "0.1.0",
  deploy: {
    host: "huginmunin",
    systemd_unit: "ratatoskr",
    platform: "bare-metal",
  },
  metrics: [],
  panels: [],
  alerts: { rules: [], active_count: 0, firing: [] },
  links: {
    self: "/heimdall.json",
    health: "/health",
    repo: "https://github.com/Magnus-Gille/ratatoskr",
  },
  ui: { icon: "bell", category: "infra" },
} as const;
