import express, { type Express, type Request, type Response } from "express";
import { requireSendApiKey } from "./auth.js";
import {
  type AlertEnvelope,
  renderAlertText,
  validateAlert,
} from "./alert.js";

export interface SendHandlerDeps {
  /** Send a Telegram message. In production this wraps `bot.api.sendMessage`. */
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  /** Telegram user IDs (as strings) permitted to receive sends. */
  allowedUsers: string[];
  /** Error sink for send failures. Injectable so tests can assert/silence it. */
  logError?: (message: string, err: unknown) => void;
  /**
   * Best-effort echo of an alert envelope to Heimdall's ingest. Optional —
   * when unset (HEIMDALL_INGEST_URL unconfigured) the echo is skipped. A
   * rejection here never fails the Telegram send (issue #16).
   */
  notifyHeimdall?: (alert: AlertEnvelope) => Promise<void>;
}

export interface SendRouteDeps extends SendHandlerDeps {
  /** Bearer token for POST /api/send. Empty string = unset. */
  sendApiKey: string;
  /** Bind host — decides the fail-closed posture for an unset key. */
  host: string;
}

/**
 * The POST /api/send request handler, dependency-injected so it can be unit
 * tested without booting the bot or binding a port. Assumes auth and JSON body
 * parsing have already run (see {@link registerSendRoute}).
 */
export function createSendHandler(
  deps: SendHandlerDeps
): (req: Request, res: Response) => Promise<void> {
  const logError =
    deps.logError ?? ((message, err) => console.error(message, err));

  return async (req: Request, res: Response): Promise<void> => {
    const { chat_id, text, alert } = (req.body ?? {}) as {
      chat_id?: unknown;
      text?: unknown;
      alert?: unknown;
    };

    if (typeof chat_id !== "number") {
      res
        .status(400)
        .json({ error: "chat_id (number) and text (string) are required" });
      return;
    }

    // Resolve the message to send: an explicit, non-blank `text` always wins and
    // preserves the legacy behavior (any `alert` is ignored for rendering but
    // still echoed). Otherwise fall back to rendering a valid `alert` envelope.
    // Whitespace-only text falls through so a placeholder text alongside a real
    // alert renders the alert rather than 500ing on an empty Telegram message.
    const hasText = typeof text === "string" && text.trim().length > 0;
    const validAlert = alert !== undefined ? validateAlert(alert) : null;

    let messageText: string;
    if (hasText) {
      messageText = text as string;
      // An alert was supplied but failed validation; text wins so it's silently
      // dropped from both the render and the echo. Surface it for observability.
      if (alert !== undefined && !validAlert) {
        logError("Alert supplied but invalid; not rendered or echoed:", alert);
      }
    } else if (validAlert) {
      messageText = renderAlertText(validAlert);
    } else if (alert !== undefined) {
      // An alert was supplied but is malformed, and there is no text fallback.
      res.status(400).json({ error: "alert.title (string) is required" });
      return;
    } else {
      res
        .status(400)
        .json({ error: "chat_id (number) and text (string) are required" });
      return;
    }

    if (!deps.allowedUsers.includes(chat_id.toString())) {
      res.status(403).json({ error: "chat_id not in allowed users list" });
      return;
    }

    try {
      await deps.sendMessage(chat_id, messageText);
    } catch (err) {
      logError("Failed to send Telegram message:", err);
      res.status(500).json({ error: String(err) });
      return;
    }

    // Best-effort echo to Heimdall — only when a valid alert was supplied and a
    // notifier is configured. A failure here must NOT fail the request.
    if (validAlert && deps.notifyHeimdall) {
      try {
        await deps.notifyHeimdall(validAlert);
      } catch (err) {
        logError("Failed to echo alert to Heimdall:", err);
      }
    }

    res.json({ ok: true });
  };
}

/**
 * Mount POST /api/send on `app` with the full middleware chain in order:
 * auth → JSON body parse → handler.
 *
 * express.json() is scoped to this route only — and crucially mounted *after*
 * requireSendApiKey — so unauthenticated requests never reach the JSON parser.
 * /health stays a GET on the main app and needs no body parsing.
 */
export function registerSendRoute(app: Express, deps: SendRouteDeps): void {
  app.post(
    "/api/send",
    requireSendApiKey(deps.sendApiKey, deps.host),
    express.json(),
    createSendHandler(deps)
  );
}
