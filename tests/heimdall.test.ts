/**
 * Tests for GET /heimdall.json — Heimdall Tier-1 self-descriptor endpoint.
 *
 * Key assertions:
 *   1. Route returns 200 WITHOUT any RATATOSKR_SEND_API_KEY (unauthenticated).
 *   2. Route is NOT affected by the /api/send auth gate (401 for bad key).
 *   3. Descriptor body passes the shape contract expected by
 *      Heimdall's validateDescriptor (schema/service/v1).
 *   4. status and metrics are computed from real live state (issue #27) —
 *      not the hardcoded status:'pass' / metrics:[] this replaces.
 *
 * We do NOT cross-require heimdall — the validator is replicated from
 * heimdall/src/contract/schema.js (the minimal subset that can hard-fail).
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { registerSendRoute } from "../src/send-handler.js";
import { buildHeimdallDescriptor } from "../src/descriptor.js";
import type { DescriptorState } from "../src/descriptor.js";

// ---------------------------------------------------------------------------
// Inline subset of heimdall validateDescriptor (schema/service/v1)
// Only hard-fail checks — warnings are noted but don't fail the assertion.
// ---------------------------------------------------------------------------

const ARCHETYPES = [
  "inference",
  "http-service",
  "timer",
  "static",
  "mcp",
] as const;
const CRITICALITIES = ["high", "normal", "low"] as const;
const STATUSES = ["pass", "warn", "fail"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Mirrors heimdall's isSafeHref — protocol-relative `//` is rejected. */
function isSafeHref(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  if (url.startsWith("//")) return false;
  if (url.startsWith("/")) return true;
  return /^https?:\/\//i.test(url);
}

interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function validateDescriptor(obj: unknown): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObj(obj)) {
    return {
      ok: false,
      errors: ["descriptor must be a JSON object"],
      warnings,
    };
  }

  const schema = (obj as Record<string, unknown>)._schema;
  if (typeof schema === "string" && !schema.includes("/service/v1")) {
    warnings.push(`unrecognized _schema "${schema}" — rendering best-effort`);
  }

  const svc = (obj as Record<string, unknown>).service;
  if (
    !isObj(svc) ||
    typeof (svc as Record<string, unknown>).name !== "string" ||
    !(svc as Record<string, unknown>).name
  ) {
    errors.push("service.name is required");
  }

  const kind = (obj as Record<string, unknown>).kind;
  if (!ARCHETYPES.includes(kind as (typeof ARCHETYPES)[number])) {
    warnings.push(`unknown kind "${kind}" — defaulting to http-service`);
  }

  const status = (obj as Record<string, unknown>).status;
  if (
    status != null &&
    !STATUSES.includes(status as (typeof STATUSES)[number])
  ) {
    warnings.push(`unknown status "${status}"`);
  }

  // Validate all links are safe hrefs (no protocol-relative or JS urls)
  const links = (obj as Record<string, unknown>).links;
  if (isObj(links)) {
    for (const [k, v] of Object.entries(links)) {
      if (!isSafeHref(v)) {
        errors.push(`link "${k}" fails isSafeHref: "${v}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTHY_STATE: DescriptorState = {
  botConnected: true,
  activePolls: 2,
  triage: {
    total: 7,
    byAction: { ready: 3, clarify: 1, answer: 3 },
    avgLatencyMs: 842,
    avgInputTokens: 310,
    avgOutputTokens: 64,
  },
};

const DOWN_STATE: DescriptorState = {
  botConnected: false,
  activePolls: 0,
  triage: { total: 0, byAction: { ready: 0, clarify: 0, answer: 0 }, avgLatencyMs: 0, avgInputTokens: 0, avgOutputTokens: 0 },
};

// ---------------------------------------------------------------------------
// Minimal app factory — mirrors how src/index.ts builds the app, without
// importing index.ts directly (which runs validateConfig() at module level).
// ---------------------------------------------------------------------------

function makeApp(
  opts: { sendApiKey?: string; host?: string; state?: DescriptorState } = {}
) {
  const app = express();

  // Unauthenticated routes (same order as index.ts)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/heimdall.json", (_req, res) => {
    res.json(buildHeimdallDescriptor(opts.state ?? HEALTHY_STATE));
  });

  // Authenticated route — mirrors registerSendRoute from index.ts
  registerSendRoute(app, {
    sendMessage: async () => {},
    allowedUsers: ["123"],
    sendApiKey: opts.sendApiKey ?? "test-key-abc",
    host: opts.host ?? "100.97.117.37", // non-loopback → key enforced
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /heimdall.json", () => {
  it("returns 200 with no Authorization header (unauthenticated)", async () => {
    const app = makeApp();
    const res = await request(app).get("/heimdall.json");
    expect(res.status).toBe(200);
  });

  it("returns Content-Type application/json", async () => {
    const app = makeApp();
    const res = await request(app).get("/heimdall.json");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("body passes the schema/service/v1 contract with 0 errors", () => {
    const result = validateDescriptor(buildHeimdallDescriptor(HEALTHY_STATE));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("descriptor has _schema ending in /service/v1", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE)._schema).toContain(
      "/service/v1"
    );
  });

  it("descriptor service.name is 'ratatoskr'", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).service.name).toBe(
      "ratatoskr"
    );
  });

  it("descriptor kind is a valid archetype", () => {
    expect(ARCHETYPES).toContain(
      buildHeimdallDescriptor(HEALTHY_STATE).kind as string
    );
  });

  it("descriptor kind is http-service", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).kind).toBe("http-service");
  });

  it("descriptor deploy.host matches instance_id", () => {
    const d = buildHeimdallDescriptor(HEALTHY_STATE);
    expect(d.deploy.host).toBe(d.service.instance_id);
  });

  it("all links pass isSafeHref (no protocol-relative or JS URLs)", () => {
    for (const [key, val] of Object.entries(
      buildHeimdallDescriptor(HEALTHY_STATE).links
    )) {
      expect(isSafeHref(val), `link "${key}" must pass isSafeHref`).toBe(
        true
      );
    }
  });

  it("links.self is root-relative /heimdall.json", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).links.self).toBe(
      "/heimdall.json"
    );
  });

  it("links.repo is an absolute https URL", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).links.repo).toMatch(
      /^https:\/\//
    );
  });

  it("response body matches buildHeimdallDescriptor(state) exactly", async () => {
    const app = makeApp();
    const res = await request(app).get("/heimdall.json");
    expect(res.body).toEqual(buildHeimdallDescriptor(HEALTHY_STATE));
  });
});

describe("GET /heimdall.json — real status and metrics (issue #27)", () => {
  it("status is 'pass' when the bot is connected", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).status).toBe("pass");
  });

  it("status is 'fail' when the bot is disconnected — not hardcoded 'pass'", () => {
    expect(buildHeimdallDescriptor(DOWN_STATE).status).toBe("fail");
  });

  it("metrics is non-empty (was hardcoded to [])", () => {
    expect(buildHeimdallDescriptor(HEALTHY_STATE).metrics.length).toBeGreaterThan(0);
  });

  it("every metric has the key/label/unit/kind/chart shape the schema expects", () => {
    for (const m of buildHeimdallDescriptor(HEALTHY_STATE).metrics) {
      expect(typeof m.key).toBe("string");
      expect(typeof m.label).toBe("string");
      expect(typeof m.unit).toBe("string");
      expect(["gauge", "counter"]).toContain(m.kind);
      expect(typeof m.chart).toBe("boolean");
    }
  });

  it("reflects live active_polls and bot_connected values", () => {
    const metrics = buildHeimdallDescriptor(HEALTHY_STATE).metrics;
    const activePolls = metrics.find((m) => m.key === "active_polls");
    const botConnected = metrics.find((m) => m.key === "bot_connected");
    expect(activePolls?.value).toBe(2);
    expect(botConnected?.value).toBe(1);
  });

  it("reflects live triage competence stats (decisions, latency, tokens)", () => {
    const metrics = buildHeimdallDescriptor(HEALTHY_STATE).metrics;
    const total = metrics.find((m) => m.key === "triage_decisions_total");
    const latency = metrics.find((m) => m.key === "triage_avg_latency_ms");
    const inputTokens = metrics.find((m) => m.key === "triage_avg_input_tokens");
    const outputTokens = metrics.find((m) => m.key === "triage_avg_output_tokens");
    expect(total?.value).toBe(7);
    expect(latency?.value).toBe(842);
    expect(inputTokens?.value).toBe(310);
    expect(outputTokens?.value).toBe(64);
  });

  it("zeroes out to 0/0 gracefully when nothing has happened yet (no NaN)", () => {
    const metrics = buildHeimdallDescriptor(DOWN_STATE).metrics;
    for (const m of metrics) {
      expect(Number.isFinite(m.value)).toBe(true);
    }
  });
});

describe("GET /heimdall.json — auth isolation", () => {
  it("is reachable WITHOUT the send API key (returns 200, not 401)", async () => {
    // Non-loopback host + send key set → /api/send is key-gated.
    // /heimdall.json must NOT be gated by the same middleware.
    const app = makeApp({ sendApiKey: "secret-key", host: "100.97.117.37" });

    const heimdall = await request(app).get("/heimdall.json");
    expect(heimdall.status).toBe(200);
  });

  it("POST /api/send without key returns 401 (confirms key IS enforced on that route)", async () => {
    const app = makeApp({ sendApiKey: "secret-key", host: "100.97.117.37" });

    const send = await request(app)
      .post("/api/send")
      .send({ chat_id: 123, text: "hi" });
    expect(send.status).toBe(401);
  });
});
