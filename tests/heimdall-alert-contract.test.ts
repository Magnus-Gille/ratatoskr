/**
 * Ratatoskr -> Heimdall alert-ingest consumer contract (issue #57).
 *
 * The consumer files in fixtures/heimdall-alert-ingest are byte-exact copies of:
 *   Magnus-Gille/heimdall@67d248dd547322867d78810bb914fd9d25fe2db4
 *   src/alert-ingest.js
 *   src/fleet/auth.js
 *
 * Only src/db.js is a test stub. Every database operation exercised below is
 * injected through Heimdall's own handleAlertIngest options.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { validateAlert } from "../src/alert.js";

const require = createRequire(import.meta.url);
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "heimdall-alert-ingest",
);
const alertIngestPath = join(fixtureRoot, "src", "alert-ingest.js");
const authPath = join(fixtureRoot, "src", "fleet", "auth.js");

const EXPECTED_HASHES = {
  "src/alert-ingest.js":
    "1e4d03a33ef347c59f1521849daacf47472097527f9a6f4c92fc36573b3e9455",
  "src/fleet/auth.js":
    "b3797f97bae5aa58247cb23523e4fbae65722e95a384c891c2164a7d45a83f05",
} as const;

type HandleAlertIngest = (
  db: object,
  options: {
    authHeader: string;
    token: string;
    bindHost: string;
    body: unknown;
    createAlertFn?: (...args: unknown[]) => number;
    resolveAlertByDedupKeyFn?: (...args: unknown[]) => number;
  },
) => { status: number; body: Record<string, unknown> };

const { handleAlertIngest } = require(alertIngestPath) as {
  handleAlertIngest: HandleAlertIngest;
};

const AUTH = {
  token: "fixture-token",
  authHeader: "Bearer fixture-token",
  bindHost: "192.0.2.1",
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("vendored Heimdall consumer provenance", () => {
  it("matches the pinned consumer source byte-for-byte", () => {
    expect(sha256(readFileSync(alertIngestPath))).toBe(
      EXPECTED_HASHES["src/alert-ingest.js"],
    );
    expect(sha256(readFileSync(authPath))).toBe(
      EXPECTED_HASHES["src/fleet/auth.js"],
    );
  });

  it("detects a one-byte consumer drift mutation", () => {
    const source = readFileSync(alertIngestPath);
    const mutated = Buffer.from(source);
    mutated[0] ^= 1;
    expect(sha256(mutated)).not.toBe(EXPECTED_HASHES["src/alert-ingest.js"]);
  });
});

describe("Ratatoskr envelopes through actual Heimdall consumer exports", () => {
  it("normalizes and persists a firing alert with optional dedup identity", () => {
    const createAlertFn = vi.fn(() => 41);
    const firing = validateAlert({
      title: "contract fixture firing",
      severity: "error",
      source: "ratatoskr",
      body: "consumer contract body",
      dedup_key: "ratatoskr:contract-fixture",
      ts: "2026-07-26T00:00:00.000Z",
      links: [{ label: "advisory", url: "https://example.invalid/contract" }],
    });

    const result = handleAlertIngest({}, {
      ...AUTH,
      body: firing,
      createAlertFn,
    });

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        id: 41,
        dedup_key: "ratatoskr:contract-fixture",
      },
    });
    expect(createAlertFn).toHaveBeenCalledOnce();
    expect(createAlertFn).toHaveBeenCalledWith(
      {},
      "ratatoskr",
      "external",
      "critical",
      "contract fixture firing",
      "consumer contract body",
      {
        dedup_key: "ratatoskr:contract-fixture",
        source: "ratatoskr",
      },
    );
  });

  it("rejects resolution without a dedup key", () => {
    const resolveAlertByDedupKeyFn = vi.fn(() => 0);
    const result = handleAlertIngest({}, {
      ...AUTH,
      body: { state: "resolved" },
      resolveAlertByDedupKeyFn,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: "invalid alert",
      details: ["dedup_key is required for a resolved alert"],
    });
    expect(resolveAlertByDedupKeyFn).not.toHaveBeenCalled();
  });

  it("resolves by the normalized dedup key and remains idempotent", () => {
    const activeKeys = new Set(["ratatoskr:contract-fixture"]);
    const resolveAlertByDedupKeyFn = vi.fn((_db: unknown, key: unknown) =>
      activeKeys.delete(String(key)) ? 1 : 0,
    );
    const resolution = validateAlert({
      state: "resolved",
      dedup_key: " ratatoskr:contract-fixture ",
    });

    const first = handleAlertIngest({}, {
      ...AUTH,
      body: resolution,
      resolveAlertByDedupKeyFn,
    });
    const repeated = handleAlertIngest({}, {
      ...AUTH,
      body: resolution,
      resolveAlertByDedupKeyFn,
    });

    expect(first).toEqual({
      status: 200,
      body: {
        ok: true,
        resolved: 1,
        dedup_key: "ratatoskr:contract-fixture",
      },
    });
    expect(repeated).toEqual({
      status: 200,
      body: {
        ok: true,
        resolved: 0,
        dedup_key: "ratatoskr:contract-fixture",
      },
    });
    expect(resolveAlertByDedupKeyFn).toHaveBeenNthCalledWith(
      1,
      {},
      "ratatoskr:contract-fixture",
    );
  });

  it("makes advisory ts and links observable as not persisted", () => {
    const createAlertFn = vi.fn(() => 42);
    const firing = validateAlert({
      title: "advisory fields",
      ts: "2026-07-26T00:00:00.000Z",
      links: [{ label: "advisory", url: "https://example.invalid/contract" }],
    });

    handleAlertIngest({}, {
      ...AUTH,
      body: firing,
      createAlertFn,
    });

    expect(createAlertFn).toHaveBeenCalledWith(
      {},
      "external",
      "external",
      "warning",
      "advisory fields",
      null,
      { dedup_key: null, source: null },
    );
  });
});
