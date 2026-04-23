/**
 * HMAC-SHA256 task submission signing (v1).
 *
 * Canonicalization is kept in lockstep with Hugin's src/task-signing.ts
 * and scripts/sign-task.mjs — do not drift these without updating all
 * three. The `cross-drift` test in tests/task-signing.test.ts spawns the
 * Hugin helper and asserts byte-equal output against this module.
 *
 * See hugin/docs/security/task-signing.md.
 */

import { createHmac, createHash } from "node:crypto";

export const SIGNATURE_VERSION = "v1" as const;

export interface SigningParams {
  taskId: string;
  submitter: string;
  submittedAt: string;
  runtime: string;
  prompt: string;
  contextRefs?: string[];
}

export function canonicalizePrompt(raw: string): string {
  return raw.trim();
}

export function buildCanonicalPayload(params: SigningParams): string {
  const promptSha = sha256Hex(canonicalizePrompt(params.prompt));
  const contextRefsSha = params.contextRefs?.length
    ? sha256Hex(canonicalizeContextRefs(params.contextRefs))
    : "";

  const fields: Record<string, string> = {
    "context-refs-sha256": contextRefsSha,
    "prompt-sha256": promptSha,
    runtime: sanitizeValue(params.runtime),
    "submitted-at": sanitizeValue(params.submittedAt),
    submitter: sanitizeValue(params.submitter),
    "task-id": sanitizeValue(params.taskId),
    version: SIGNATURE_VERSION,
  };

  return (
    Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n") + "\n"
  );
}

export function signTask(
  params: SigningParams,
  keyId: string,
  secret: string,
): string {
  const key = decodeSecret(secret);
  const payload = buildCanonicalPayload(params);
  const hex = createHmac("sha256", key).update(payload).digest("hex");
  return `${SIGNATURE_VERSION}:${keyId}:${hex}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function canonicalizeContextRefs(refs: string[]): string {
  return refs
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

function decodeSecret(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 32) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 24) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length >= 16) return decoded;
  }
  return Buffer.from(trimmed, "utf8");
}
