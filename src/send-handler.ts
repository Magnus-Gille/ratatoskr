import express, { type Express, type Request, type Response } from "express";
import { requireSendApiKey } from "./auth.js";

export interface SendHandlerDeps {
  /** Send a Telegram message. In production this wraps `bot.api.sendMessage`. */
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  /** Telegram user IDs (as strings) permitted to receive sends. */
  allowedUsers: string[];
  /** Error sink for send failures. Injectable so tests can assert/silence it. */
  logError?: (message: string, err: unknown) => void;
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
    const { chat_id, text } = (req.body ?? {}) as {
      chat_id?: unknown;
      text?: unknown;
    };
    if (typeof chat_id !== "number" || typeof text !== "string" || !text) {
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
      await deps.sendMessage(chat_id, text);
      res.json({ ok: true });
    } catch (err) {
      logError("Failed to send Telegram message:", err);
      res.status(500).json({ error: String(err) });
    }
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
