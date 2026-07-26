/**
 * Ratatoskr -> Heimdall alert-ingest consumer contract (issue #57).
 *
 * This is a pinned compatible copy of Heimdall's acceptance/normalization
 * boundary from Magnus-Gille/heimdall@67d248dd547322867d78810bb914fd9d25fe2db4,
 * src/alert-ingest.js: validateAlertEnvelope + handleAlertIngest semantics.
 * Keep the copy deliberately small: it covers the producer fields that pass
 * through Ratatoskr and the persistence calls that make the lifecycle visible.
 * Update this pin whenever Heimdall changes that contract.
 *
 * Heimdall intentionally treats `ts` and `links` as advisory: it accepts them
 * but does not persist either field. Ratatoskr renders links only for Telegram;
 * producers must not claim that Heimdall stores or renders them.
 */
import { describe, expect, it } from "vitest";
import { validateAlert } from "../src/alert.js";

const SEVERITY_CANON: Record<string, "info" | "warning" | "critical"> = {
  info: "info", notice: "info", low: "info",
  warn: "warning", warning: "warning", medium: "warning", degraded: "warning",
  error: "critical", critical: "critical", crit: "critical", fail: "critical", high: "critical",
};

type ConsumerAlert = {
  state: "firing" | "resolved";
  host: string;
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string | null;
  dedup_key: string | null;
  source: string | null;
};

/** Exact pinned Heimdall validateAlertEnvelope behavior (sans CommonJS wrapper). */
function acceptAtHeimdall(body: unknown): { ok: true; value: ConsumerAlert } | { ok: false; errors: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const outer = body as Record<string, unknown>;
  const a = outer.alert && typeof outer.alert === "object" && !Array.isArray(outer.alert)
    ? outer.alert as Record<string, unknown> : outer;
  const errors: string[] = [];
  const state = typeof a.state === "string" ? a.state.toLowerCase() : "firing";
  if (state !== "firing" && state !== "resolved") errors.push("state must be firing or resolved");
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (state === "firing" && !title) errors.push("title is required for a firing alert");
  if (title.length > 200) errors.push("title too long (max 200)");
  const dedup_key = typeof a.dedup_key === "string" && a.dedup_key.trim()
    ? a.dedup_key.trim().slice(0, 200) : null;
  if (state === "resolved" && !dedup_key) errors.push("dedup_key is required for a resolved alert");
  if (errors.length) return { ok: false, errors };

  const rawSeverity = typeof a.severity === "string" && a.severity ? a.severity.toLowerCase() : "warn";
  const source = typeof a.source === "string" && a.source ? a.source.slice(0, 120) : null;
  const detail = typeof a.body === "string" ? a.body.slice(0, 2000)
    : typeof a.detail === "string" ? a.detail.slice(0, 2000) : null;
  return {
    ok: true,
    value: {
      state,
      host: typeof a.host === "string" && a.host ? a.host.slice(0, 120) : (source || "external"),
      category: typeof a.category === "string" && a.category ? a.category.slice(0, 60) : "external",
      severity: SEVERITY_CANON[rawSeverity] || "warning",
      title,
      detail,
      dedup_key,
      source,
    },
  };
}

function ingestLifecycle(activeKeys: Set<string>, alert: ConsumerAlert): number {
  if (alert.state === "resolved") return activeKeys.delete(alert.dedup_key!) ? 1 : 0;
  if (alert.dedup_key) activeKeys.add(alert.dedup_key);
  return 1;
}

describe("Ratatoskr alert envelopes accepted by Heimdall", () => {
  it("accepts a firing lifecycle and preserves consumer-visible fields", () => {
    const firing = validateAlert({
      title: "contract fixture firing",
      severity: "error",
      source: "ratatoskr",
      body: "consumer contract body",
      dedup_key: "ratatoskr:contract-fixture",
      ts: "2026-07-26T00:00:00.000Z",
      links: [{ label: "advisory", url: "https://example.invalid/contract" }],
    });
    expect(firing).not.toBeNull();

    const accepted = acceptAtHeimdall(firing);
    expect(accepted).toEqual({
      ok: true,
      value: {
        state: "firing",
        host: "ratatoskr",
        category: "external",
        severity: "critical",
        title: "contract fixture firing",
        detail: "consumer contract body",
        dedup_key: "ratatoskr:contract-fixture",
        source: "ratatoskr",
      },
    });
  });

  it("requires a dedup key for resolution and resolves by that same key", () => {
    expect(acceptAtHeimdall({ state: "resolved" })).toEqual({
      ok: false,
      errors: ["dedup_key is required for a resolved alert"],
    });

    const resolution = validateAlert({ state: "resolved", dedup_key: " ratatoskr:contract-fixture " });
    expect(resolution).toEqual({ state: "resolved", dedup_key: "ratatoskr:contract-fixture" });
    const accepted = acceptAtHeimdall(resolution);
    expect(accepted).toMatchObject({
      ok: true,
      value: { state: "resolved", dedup_key: "ratatoskr:contract-fixture" },
    });
    const activeKeys = new Set(["ratatoskr:contract-fixture"]);
    expect(accepted.ok && ingestLifecycle(activeKeys, accepted.value)).toBe(1);
    expect(activeKeys).toEqual(new Set());
  });

  it("documents that accepted ts and links are advisory rather than persisted", () => {
    const accepted = acceptAtHeimdall(validateAlert({
      title: "advisory fields",
      ts: "2026-07-26T00:00:00.000Z",
      links: [{ label: "advisory", url: "https://example.invalid/contract" }],
    }));
    expect(accepted).toMatchObject({ ok: true, value: { detail: null } });
    expect(accepted).not.toHaveProperty("value.ts");
    expect(accepted).not.toHaveProperty("value.links");
  });
});
