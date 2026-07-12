import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_REMINDER_TEXT_LENGTH = 4096;
export const MAX_REMINDER_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_REMINDERS = 1000;
export const TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 30_000;
const DELIVERY_RETRY_DELAY_MS = 30_000;

export type ReminderStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

export interface Reminder {
  id: string;
  idempotencyKey: string;
  chatId: number;
  text: string;
  deliverAt: string;
  status: ReminderStatus;
  createdAt: string;
  attemptedAt?: string;
  error?: string;
}

export interface ReminderInput {
  chatId: number;
  text: string;
  deliverAt: string;
  idempotencyKey: string;
}

export interface ReminderCounts {
  pending: number;
  failed: number;
}

export class ReminderValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ReminderValidationError";
  }
}

interface ReminderStoreFile {
  version: 1;
  reminders: Reminder[];
}

const REMINDER_STATUSES = new Set<ReminderStatus>([
  "pending",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

function isReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Reminder>;
  return (
    typeof item.id === "string" &&
    typeof item.idempotencyKey === "string" &&
    Number.isSafeInteger(item.chatId) &&
    typeof item.text === "string" &&
    typeof item.deliverAt === "string" &&
    Number.isFinite(Date.parse(item.deliverAt)) &&
    typeof item.createdAt === "string" &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    REMINDER_STATUSES.has(item.status as ReminderStatus) &&
    (item.attemptedAt === undefined ||
      (typeof item.attemptedAt === "string" &&
        Number.isFinite(Date.parse(item.attemptedAt)))) &&
    (item.error === undefined || typeof item.error === "string")
  );
}

interface ReminderQueueOptions {
  storePath: string;
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  now?: () => number;
  maxFutureMs?: number;
  logError?: (message: string, err: unknown) => void;
}

export class DurableReminderQueue {
  private reminders: Reminder[] = [];
  private operation: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private initialized = false;
  private stopped = true;
  private deliveryRunning = false;
  private disabledReason: string | null = null;
  private readonly now: () => number;
  private readonly maxFutureMs: number;
  private readonly logError: (message: string, err: unknown) => void;

  constructor(private readonly options: ReminderQueueOptions) {
    this.now = options.now ?? Date.now;
    this.maxFutureMs = options.maxFutureMs ?? MAX_REMINDER_FUTURE_MS;
    this.logError = options.logError ?? ((message, err) => console.error(message, err));
  }

  async initialize(): Promise<void> {
    await this.serial(async () => {
      try {
        const raw = await readFile(this.options.storePath, "utf8");
        const parsed = JSON.parse(raw) as ReminderStoreFile;
        if (
          parsed.version !== 1 ||
          !Array.isArray(parsed.reminders) ||
          !parsed.reminders.every(isReminder)
        ) {
          throw new Error("unsupported reminder store format");
        }
        this.reminders = parsed.reminders;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.reminders = [];
          try {
            await this.persist();
          } catch (persistErr) {
            this.disable("reminder store unavailable", persistErr);
          }
        } else {
          // Keep Telegram routing alive. Quarantine a corrupt store when
          // possible; if the path itself is inaccessible, disable only the
          // reminder API/delivery loop and surface 503s.
          this.logError("Reminder store is unreadable; attempting quarantine:", err);
          try {
            await rename(
              this.options.storePath,
              `${this.options.storePath}.corrupt-${this.now()}`
            );
            this.reminders = [];
            await this.persist();
          } catch (recoveryErr) {
            this.reminders = [];
            this.disable("reminder store unavailable", recoveryErr);
          }
        }
      }

      // At-most-once attempt semantics: a crash after the durable `sending`
      // transition is never retried because Telegram has no idempotency key.
      // Mark it failed visibly instead of risking a duplicate after restart.
      let repaired = false;
      for (const reminder of this.reminders) {
        if (reminder.status === "sending") {
          reminder.status = "failed";
          reminder.error = "delivery_interrupted_not_retried";
          repaired = true;
        }
      }
      if (repaired && !this.disabledReason) {
        try {
          await this.persist();
        } catch (err) {
          this.disable("reminder store unavailable", err);
        }
      }
      this.initialized = true;
    });
  }

  start(): void {
    this.assertInitialized();
    if (this.disabledReason) return;
    this.stopped = false;
    this.armTimer();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async schedule(
    input: ReminderInput
  ): Promise<{ reminder: Reminder; deduplicated: boolean }> {
    const result = await this.serial(async () => {
      this.assertInitialized();
      this.assertAvailable();
      const existing = this.reminders.find(
        (reminder) =>
          reminder.chatId === input.chatId &&
          reminder.idempotencyKey === input.idempotencyKey?.trim()
      );
      if (existing) {
        const normalized = this.validateInput(input, true);
        const sameRequest =
          existing.chatId === normalized.chatId &&
          existing.text === normalized.text &&
          existing.deliverAt === normalized.deliverAt;
        if (!sameRequest) {
          throw new ReminderValidationError(
            "idempotency_key already belongs to a different reminder",
            409
          );
        }
        return { reminder: { ...existing }, deduplicated: true };
      }

      const normalized = this.validateInput(input);
      if (
        this.reminders.filter((reminder) => reminder.status === "pending").length >=
        MAX_PENDING_REMINDERS
      ) {
        throw new ReminderValidationError("too many pending reminders", 429);
      }
      this.pruneTerminal();

      const reminder: Reminder = {
        id: randomUUID(),
        idempotencyKey: normalized.idempotencyKey,
        chatId: normalized.chatId,
        text: normalized.text,
        deliverAt: normalized.deliverAt,
        status: "pending",
        createdAt: new Date(this.now()).toISOString(),
      };
      this.reminders.push(reminder);
      try {
        await this.persist();
      } catch (err) {
        this.reminders = this.reminders.filter((item) => item.id !== reminder.id);
        throw err;
      }
      return { reminder: { ...reminder }, deduplicated: false };
    });
    this.armTimer();
    return result;
  }

  async list(status?: ReminderStatus): Promise<Reminder[]> {
    return this.serial(async () => {
      this.assertInitialized();
      this.assertAvailable();
      return this.reminders
        .filter((reminder) => !status || reminder.status === status)
        .map((reminder) => ({ ...reminder }));
    });
  }

  async get(id: string): Promise<Reminder | null> {
    return this.serial(async () => {
      this.assertInitialized();
      this.assertAvailable();
      const reminder = this.reminders.find((item) => item.id === id);
      return reminder ? { ...reminder } : null;
    });
  }

  async cancel(id: string): Promise<Reminder> {
    const result = await this.serial(async () => {
      this.assertInitialized();
      this.assertAvailable();
      const reminder = this.reminders.find((item) => item.id === id);
      if (!reminder) throw new ReminderValidationError("reminder not found", 404);
      if (reminder.status !== "pending") {
        throw new ReminderValidationError(
          `only pending reminders can be cancelled (status: ${reminder.status})`,
          409
        );
      }
      reminder.status = "cancelled";
      try {
        await this.persist();
      } catch (err) {
        reminder.status = "pending";
        throw err;
      }
      return { ...reminder };
    });
    this.armTimer();
    return result;
  }

  /** Deliver every reminder due at or before now. Public for deterministic ops/tests. */
  async processDue(): Promise<void> {
    if (this.deliveryRunning) return;
    this.deliveryRunning = true;
    let retryDelay: number | undefined;
    try {
      this.assertInitialized();
      this.assertAvailable();
      while (true) {
        // Claim and durably mark one reminder while holding the state lock, then
        // release it for the network call so status/list/cancel APIs stay live.
        const claimed = await this.serial(async () => {
          const reminder = this.reminders
            .filter(
              (item) =>
                item.status === "pending" &&
                Date.parse(item.deliverAt) <= this.now()
            )
            .sort((a, b) => Date.parse(a.deliverAt) - Date.parse(b.deliverAt))[0];
          if (!reminder) return null;
          const previousAttemptedAt = reminder.attemptedAt;
          reminder.status = "sending";
          reminder.attemptedAt = new Date(this.now()).toISOString();
          try {
            await this.persist();
          } catch (err) {
            reminder.status = "pending";
            reminder.attemptedAt = previousAttemptedAt;
            throw err;
          }
          return { ...reminder };
        });
        if (!claimed) break;

        let finalStatus: "sent" | "failed" = "sent";
        let errorCode: string | undefined;
        try {
          await this.sendWithTimeout(claimed.chatId, claimed.text);
        } catch (err) {
          finalStatus = "failed";
          errorCode =
            err instanceof Error && err.name === "ReminderDeliveryTimeout"
              ? "delivery_timeout_outcome_unknown"
              : "delivery_failed";
          this.logError(`Failed to deliver reminder ${claimed.id}:`, err);
        }

        await this.serial(async () => {
          const reminder = this.reminders.find((item) => item.id === claimed.id);
          if (!reminder || reminder.status !== "sending") return;
          reminder.status = finalStatus;
          if (errorCode) reminder.error = errorCode;
          else delete reminder.error;
          this.pruneTerminal();
          await this.persist();
        });
      }
    } catch (err) {
      retryDelay = DELIVERY_RETRY_DELAY_MS;
      throw err;
    } finally {
      this.deliveryRunning = false;
      // Always re-arm — including persistence/network-loop failures. Without
      // this finally, one ENOSPC/EIO would silently stop reminders forever.
      this.armTimer(retryDelay);
    }
  }

  counts(): ReminderCounts {
    return {
      pending: this.reminders.filter((item) => item.status === "pending").length,
      failed: this.reminders.filter((item) => item.status === "failed").length,
    };
  }

  private validateInput(input: ReminderInput, allowPast = false): ReminderInput {
    if (!Number.isSafeInteger(input.chatId)) {
      throw new ReminderValidationError("chat_id must be an integer");
    }
    if (typeof input.text !== "string" || !input.text.trim()) {
      throw new ReminderValidationError("text must be a non-empty string");
    }
    if (input.text.length > MAX_REMINDER_TEXT_LENGTH) {
      throw new ReminderValidationError(
        `text must be at most ${MAX_REMINDER_TEXT_LENGTH} characters`
      );
    }
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 200
    ) {
      throw new ReminderValidationError(
        "idempotency_key must be a non-empty string of at most 200 characters"
      );
    }
    if (
      typeof input.deliverAt !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.deliverAt)
    ) {
      throw new ReminderValidationError(
        "deliver_at must be an ISO 8601 timestamp with an explicit UTC offset"
      );
    }
    const deliverMs = Date.parse(input.deliverAt);
    const now = this.now();
    if (!Number.isFinite(deliverMs)) {
      throw new ReminderValidationError("deliver_at is not a valid timestamp");
    }
    if (!allowPast && deliverMs <= now) {
      throw new ReminderValidationError("deliver_at must be in the future");
    }
    if (deliverMs - now > this.maxFutureMs) {
      throw new ReminderValidationError("deliver_at is unreasonably far in the future");
    }
    return {
      chatId: input.chatId,
      text: input.text,
      deliverAt: new Date(deliverMs).toISOString(),
      idempotencyKey: input.idempotencyKey.trim(),
    };
  }

  private armTimer(overrideDelay?: number): void {
    if (!this.initialized || this.stopped || this.disabledReason) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.reminders
      .filter((reminder) => reminder.status === "pending")
      .reduce<number | null>((earliest, reminder) => {
        const due = Date.parse(reminder.deliverAt);
        return earliest === null || due < earliest ? due : earliest;
      }, null);
    if (next === null) return;
    // Re-evaluate at least once a minute, which also bounds clock-change drift.
    const delay =
      overrideDelay ?? Math.min(60_000, Math.max(0, next - this.now()));
    this.timer = setTimeout(() => {
      void this.processDue().catch((err) =>
        this.logError("Reminder delivery loop failed:", err)
      );
    }, delay);
    this.timer.unref();
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.options.storePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`;
    const data: ReminderStoreFile = { version: 1, reminders: this.reminders };
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.options.storePath);
      // Persist the rename itself across Pi power loss where supported.
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (err) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }
  }

  private async sendWithTimeout(chatId: number, text: string): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.options.sendMessage(chatId, text).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const err = new Error("Telegram delivery timed out");
            err.name = "ReminderDeliveryTimeout";
            reject(err);
          }, DELIVERY_TIMEOUT_MS);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private pruneTerminal(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    this.reminders = this.reminders.filter((reminder) => {
      if (reminder.status === "pending" || reminder.status === "sending") return true;
      return Date.parse(reminder.attemptedAt ?? reminder.createdAt) >= cutoff;
    });
  }

  private disable(reason: string, err: unknown): void {
    this.disabledReason = reason;
    this.logError(`${reason}; reminders disabled but Telegram routing will continue:`, err);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("reminder queue is not initialized");
  }

  private assertAvailable(): void {
    if (this.disabledReason) {
      throw new ReminderValidationError(this.disabledReason, 503);
    }
  }
}

export function reminderView(reminder: Reminder) {
  return {
    id: reminder.id,
    chat_id: reminder.chatId,
    deliver_at: reminder.deliverAt,
    status: reminder.status,
    created_at: reminder.createdAt,
    ...(reminder.attemptedAt ? { attempted_at: reminder.attemptedAt } : {}),
    ...(reminder.error ? { error: reminder.error } : {}),
  };
}
