/**
 * Alert envelope support for POST /api/send (issue #16, Grimnir v2 P3 alert bus).
 *
 * A caller may POST a standard `alert` envelope instead of (or alongside) raw
 * `text`. Ratatoskr renders a firing alert when no `text` is supplied; resolved
 * lifecycle events are forwarded without rendering. Both are — best-effort —
 * echoed to Heimdall's fail-closed `/api/alerts` ingest.
 *
 * Heimdall normalizes severity on its side ({info,warning,critical}) and dedups
 * by `dedup_key`. validateAlert rebuilds a clean, allowlisted envelope from the
 * untrusted request body, so only known, type-checked, bounded fields are ever
 * rendered or forwarded across the Ratatoskr→Heimdall trust boundary.
 */

import { TELEGRAM_MAX_LENGTH } from "./telegram-util.js";

export type AlertSeverity = "info" | "warn" | "error" | "critical";

const KNOWN_SEVERITIES = new Set<AlertSeverity>([
  "info",
  "warn",
  "error",
  "critical",
]);

export interface AlertLink {
  label: string;
  url: string;
}

/** Cap on links carried across the trust boundary into Heimdall / the render. */
const MAX_LINKS = 10;

/**
 * A link URL is renderable only if it parses and uses http/https. This blocks
 * `javascript:`, `data:`, `file:`, and other schemes that a downstream display
 * surface (Heimdall renders links as clickable) could execute or mis-handle.
 */
function isSafeHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

interface AlertEnvelopeFields {
  severity?: AlertSeverity;
  source?: string;
  body?: string;
  ts?: string;
  links?: AlertLink[];
}

export interface FiringAlertEnvelope extends AlertEnvelopeFields {
  state?: "firing";
  title: string;
  dedup_key?: string;
}

export interface ResolvedAlertEnvelope extends AlertEnvelopeFields {
  state: "resolved";
  title?: string;
  dedup_key: string;
}

export type AlertEnvelope = FiringAlertEnvelope | ResolvedAlertEnvelope;

/**
 * Validate an untrusted value as an AlertEnvelope. Firing alerts require a
 * non-empty title; resolution events require `state: "resolved"` and a non-empty
 * dedup key. Rather than returning the raw request object, this constructs a
 * fresh envelope containing only known fields that pass a type check — so
 * unknown/oversized/wrong-typed fields never reach Telegram or Heimdall.
 */
export function validateAlert(value: unknown): AlertEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const a = value as Record<string, unknown>;

  if (
    a.state !== undefined &&
    a.state !== "firing" &&
    a.state !== "resolved"
  ) {
    return null;
  }
  const isResolved = a.state === "resolved";
  const title = typeof a.title === "string" ? a.title.trim() : "";
  const dedupKey =
    typeof a.dedup_key === "string" ? a.dedup_key.trim() : "";
  if ((!isResolved && title === "") || (isResolved && dedupKey === "")) {
    return null;
  }

  const alert: AlertEnvelope = isResolved
    ? { state: "resolved", dedup_key: dedupKey }
    : {
        ...(a.state === "firing" ? { state: "firing" as const } : {}),
        title: a.title as string,
      };

  if (isResolved && title !== "") alert.title = a.title as string;

  if (
    typeof a.severity === "string" &&
    KNOWN_SEVERITIES.has(a.severity as AlertSeverity)
  ) {
    alert.severity = a.severity as AlertSeverity;
  }
  if (typeof a.source === "string") alert.source = a.source;
  if (typeof a.body === "string") alert.body = a.body;
  if (!isResolved && typeof a.dedup_key === "string") {
    alert.dedup_key = a.dedup_key;
  }
  if (typeof a.ts === "string") alert.ts = a.ts;

  if (Array.isArray(a.links)) {
    const links: AlertLink[] = [];
    for (const link of a.links) {
      if (links.length >= MAX_LINKS) break;
      if (
        !link ||
        typeof link !== "object" ||
        typeof (link as AlertLink).label !== "string" ||
        typeof (link as AlertLink).url !== "string"
      ) {
        continue;
      }
      const label = (link as AlertLink).label.trim();
      const url = (link as AlertLink).url.trim();
      if (label !== "" && url !== "" && isSafeHttpUrl(url)) {
        links.push({ label, url });
      }
    }
    if (links.length > 0) alert.links = links;
  }

  return alert;
}

/**
 * Render a plain-text Telegram message from an alert envelope:
 *   `SEVERITY — title`
 *   body (if present)
 *   `label: url` per link (malformed/empty links skipped)
 *
 * Defensive against non-validated input and self-bounds the result to Telegram's
 * length limit so an oversized alert never fails the send.
 */
export function renderAlertText(alert: FiringAlertEnvelope): string {
  const severity = (
    typeof alert.severity === "string" ? alert.severity : "info"
  ).toUpperCase();
  const lines: string[] = [`${severity} — ${alert.title}`];

  if (typeof alert.body === "string" && alert.body) {
    lines.push(alert.body);
  }

  if (Array.isArray(alert.links)) {
    for (const link of alert.links) {
      const label = (link as AlertLink)?.label;
      const url = (link as AlertLink)?.url;
      if (
        typeof label === "string" &&
        typeof url === "string" &&
        label.trim() !== "" &&
        url.trim() !== ""
      ) {
        lines.push(`${label}: ${url}`);
      }
    }
  }

  const text = lines.join("\n");
  if (text.length > TELEGRAM_MAX_LENGTH) {
    return text.slice(0, TELEGRAM_MAX_LENGTH - 1) + "…";
  }
  return text;
}

export interface HeimdallNotifierOptions {
  /** Heimdall ingest URL, e.g. http://huginmunin:3033/api/alerts. */
  url: string;
  /** Bearer token for Heimdall's fail-closed ingest (HEIMDALL_ALERT_TOKEN). */
  token: string;
  /** Per-request timeout. Defaults to 3000ms. */
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a function that POSTs an alert envelope to Heimdall's ingest. Throws on
 * a network error, timeout, or non-2xx response so the caller can log it — the
 * caller is responsible for treating the echo as best-effort (try/catch).
 */
export function createHeimdallNotifier(
  opts: HeimdallNotifierOptions
): (alert: AlertEnvelope) => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const doFetch = opts.fetchImpl ?? fetch;

  return async (alert: AlertEnvelope): Promise<void> => {
    const res = await doFetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Heimdall ingest returned ${res.status}`);
    }
  };
}
