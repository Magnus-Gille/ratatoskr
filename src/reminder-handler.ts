import express, { type Express, type Request, type Response } from "express";
import { requireSendApiKey } from "./auth.js";
import {
  DurableReminderQueue,
  ReminderValidationError,
  type ReminderStatus,
  reminderView,
} from "./reminders.js";

export interface ReminderRouteDeps {
  queue: DurableReminderQueue;
  allowedUsers: string[];
  sendApiKey: string;
  host: string;
}

const STATUSES = new Set<ReminderStatus>([
  "pending",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

function handleError(res: Response, err: unknown): void {
  if (err instanceof ReminderValidationError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  console.error("Reminder API error:", err);
  res.status(500).json({ error: "reminder store error" });
}

function routeId(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
}

export function registerReminderRoutes(
  app: Express,
  deps: ReminderRouteDeps
): void {
  const auth = requireSendApiKey(deps.sendApiKey, deps.host);
  const json = express.json();

  app.post("/api/reminders", auth, json, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.chat_id !== "number" ||
      !deps.allowedUsers.includes(body.chat_id.toString())
    ) {
      if (typeof body.chat_id !== "number") {
        res.status(400).json({ error: "chat_id must be a number" });
      } else {
        res.status(403).json({ error: "chat_id not in allowed users list" });
      }
      return;
    }
    try {
      const result = await deps.queue.schedule({
        chatId: body.chat_id,
        text: body.text as string,
        deliverAt: body.deliver_at as string,
        idempotencyKey: body.idempotency_key as string,
      });
      res.status(result.deduplicated ? 200 : 202).json({
        accepted: true,
        persisted: true,
        sent: result.reminder.status === "sent",
        deduplicated: result.deduplicated,
        reminder: reminderView(result.reminder),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/reminders", auth, async (req: Request, res: Response) => {
    const requested = typeof req.query.status === "string" ? req.query.status : undefined;
    if (requested && !STATUSES.has(requested as ReminderStatus)) {
      res.status(400).json({ error: "invalid status filter" });
      return;
    }
    try {
      const reminders = await deps.queue.list(requested as ReminderStatus | undefined);
      res.json({ reminders: reminders.map(reminderView) });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/reminders/:id", auth, async (req: Request, res: Response) => {
    try {
      const reminder = await deps.queue.get(routeId(req));
      if (!reminder) {
        res.status(404).json({ error: "reminder not found" });
        return;
      }
      res.json({ reminder: reminderView(reminder) });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete("/api/reminders/:id", auth, async (req: Request, res: Response) => {
    try {
      const reminder = await deps.queue.cancel(routeId(req));
      res.json({ cancelled: true, reminder: reminderView(reminder) });
    } catch (err) {
      handleError(res, err);
    }
  });
}
