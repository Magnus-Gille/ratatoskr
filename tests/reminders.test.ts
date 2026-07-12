import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DurableReminderQueue,
  MAX_REMINDER_FUTURE_MS,
  MAX_REMINDER_TEXT_LENGTH,
  ReminderValidationError,
} from "../src/reminders.js";

async function setup(now = Date.parse("2026-07-12T20:00:00Z")) {
  const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-reminders-"));
  const storePath = path.join(dir, "reminders.json");
  const clock = { now };
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const queue = new DurableReminderQueue({
    storePath,
    sendMessage,
    now: () => clock.now,
    logError: vi.fn(),
  });
  await queue.initialize();
  return { queue, storePath, clock, sendMessage };
}

function input(overrides: Partial<{
  chatId: number;
  text: string;
  deliverAt: string;
  idempotencyKey: string;
}> = {}) {
  return {
    chatId: 123,
    text: "check the BIOS",
    deliverAt: "2026-07-12T20:01:00Z",
    idempotencyKey: "bios-check",
    ...overrides,
  };
}

describe("DurableReminderQueue", () => {
  it("persists pending reminders across restart", async () => {
    const { queue, storePath, clock } = await setup();
    const created = await queue.schedule(input());
    expect(created.deduplicated).toBe(false);
    expect(created.reminder.status).toBe("pending");

    const restarted = new DurableReminderQueue({
      storePath,
      sendMessage: vi.fn(),
      now: () => clock.now,
    });
    await restarted.initialize();
    expect(await restarted.get(created.reminder.id)).toMatchObject({
      id: created.reminder.id,
      status: "pending",
      text: "check the BIOS",
    });
  });

  it("deduplicates identical retries and conflicts on key reuse", async () => {
    const { queue } = await setup();
    const first = await queue.schedule(input());
    const retry = await queue.schedule(input());
    expect(retry.deduplicated).toBe(true);
    expect(retry.reminder.id).toBe(first.reminder.id);
    expect(await queue.list()).toHaveLength(1);

    await expect(queue.schedule(input({ text: "different" }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("scopes idempotency keys per chat", async () => {
    const { queue } = await setup();
    const first = await queue.schedule(input());
    const second = await queue.schedule(input({ chatId: 456 }));
    expect(second.reminder.id).not.toBe(first.reminder.id);
  });

  it("deduplicates an ambiguous retry even after its deliver_at has passed", async () => {
    const { queue, clock } = await setup();
    const first = await queue.schedule(input());
    clock.now = Date.parse(first.reminder.deliverAt) + 1;
    const retry = await queue.schedule(input());
    expect(retry.deduplicated).toBe(true);
    expect(retry.reminder.id).toBe(first.reminder.id);
  });

  it("delivers exactly at the due-time boundary and never twice", async () => {
    const { queue, clock, sendMessage } = await setup();
    const created = await queue.schedule(input());
    clock.now = Date.parse(created.reminder.deliverAt);
    await queue.processDue();
    await queue.processDue();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(123, "check the BIOS");
    expect(await queue.get(created.reminder.id)).toMatchObject({ status: "sent" });
  });

  it("does not deliver before the boundary", async () => {
    const { queue, clock, sendMessage } = await setup();
    const created = await queue.schedule(input());
    clock.now = Date.parse(created.reminder.deliverAt) - 1;
    await queue.processDue();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await queue.get(created.reminder.id)).toMatchObject({ status: "pending" });
  });

  it("persists failures without automatic retry", async () => {
    const { queue, clock, sendMessage } = await setup();
    sendMessage.mockRejectedValue(new Error("telegram unavailable"));
    const created = await queue.schedule(input());
    clock.now = Date.parse(created.reminder.deliverAt);
    await queue.processDue();
    await queue.processDue();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(await queue.get(created.reminder.id)).toMatchObject({
      status: "failed",
      error: "delivery_failed",
    });
  });

  it("marks an interrupted sending attempt failed on restart", async () => {
    const { queue, storePath, clock } = await setup();
    const created = await queue.schedule(input());
    const store = JSON.parse(await readFile(storePath, "utf8"));
    store.reminders[0].status = "sending";
    store.reminders[0].attemptedAt = new Date(clock.now).toISOString();
    await writeFile(storePath, JSON.stringify(store));

    const sendMessage = vi.fn();
    const restarted = new DurableReminderQueue({
      storePath,
      sendMessage,
      now: () => clock.now,
    });
    await restarted.initialize();
    clock.now = Date.parse(created.reminder.deliverAt);
    await restarted.processDue();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await restarted.get(created.reminder.id)).toMatchObject({
      status: "failed",
      error: "delivery_interrupted_not_retried",
    });
  });

  it("quarantines a corrupt store instead of crashing Telegram routing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-corrupt-reminders-"));
    const storePath = path.join(dir, "reminders.json");
    await writeFile(storePath, "{not json");
    const logError = vi.fn();
    const queue = new DurableReminderQueue({
      storePath,
      sendMessage: vi.fn(),
      now: () => Date.parse("2026-07-12T20:00:00Z"),
      logError,
    });
    await expect(queue.initialize()).resolves.toBeUndefined();
    expect(await queue.list()).toEqual([]);
    expect((await readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(true);
    expect(logError).toHaveBeenCalled();
  });

  it("disables only reminders when the store path is unavailable", async () => {
    const queue = new DurableReminderQueue({
      storePath: "/dev/null/reminders.json",
      sendMessage: vi.fn(),
      logError: vi.fn(),
    });
    await expect(queue.initialize()).resolves.toBeUndefined();
    expect(() => queue.start()).not.toThrow();
    await expect(queue.list()).rejects.toMatchObject({ statusCode: 503 });
  });

  it("keeps the API responsive while Telegram delivery is in flight", async () => {
    let release!: () => void;
    const sendMessage = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-concurrent-reminders-"));
    const clock = { now: Date.parse("2026-07-12T20:00:00Z") };
    const queue = new DurableReminderQueue({
      storePath: path.join(dir, "reminders.json"),
      sendMessage,
      now: () => clock.now,
    });
    await queue.initialize();
    const created = await queue.schedule(input());
    clock.now = Date.parse(created.reminder.deliverAt);
    const delivery = queue.processDue();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await expect(queue.list()).resolves.toHaveLength(1);
    release();
    await delivery;
  });

  it("uses the timer path and re-arms after a persistence failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-timer-reminders-"));
    const storePath = path.join(dir, "reminders.json");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const queue = new DurableReminderQueue({ storePath, sendMessage, logError });
    await queue.initialize();
    await queue.schedule({
      ...input(),
      deliverAt: new Date(Date.now() + 30).toISOString(),
    });
    (queue as any).options.storePath = dir;
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendMessage).not.toHaveBeenCalled();
    expect((queue as any).timer).not.toBeNull();
    expect(logError).toHaveBeenCalled();
    queue.stop();
  });

  it("cancels only pending reminders", async () => {
    const { queue, clock } = await setup();
    const created = await queue.schedule(input());
    expect(await queue.cancel(created.reminder.id)).toMatchObject({ status: "cancelled" });
    await expect(queue.cancel(created.reminder.id)).rejects.toMatchObject({ statusCode: 409 });

    const second = await queue.schedule(input({ idempotencyKey: "second" }));
    clock.now = Date.parse(second.reminder.deliverAt);
    await queue.processDue();
    await expect(queue.cancel(second.reminder.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("validates timestamp, horizon, text, chat id, and idempotency key", async () => {
    const { queue, clock } = await setup();
    const rejects = async (value: ReturnType<typeof input>) => {
      await expect(queue.schedule(value)).rejects.toBeInstanceOf(ReminderValidationError);
    };
    await rejects(input({ deliverAt: "2026-07-12T20:01:00" }));
    await rejects(input({ deliverAt: new Date(clock.now).toISOString() }));
    await rejects(
      input({ deliverAt: new Date(clock.now + MAX_REMINDER_FUTURE_MS + 1).toISOString() })
    );
    await rejects(input({ text: "x".repeat(MAX_REMINDER_TEXT_LENGTH + 1) }));
    await rejects(input({ chatId: 1.5 }));
    await rejects(input({ idempotencyKey: "" }));
  });

  it("exposes only content-blind counts", async () => {
    const { queue } = await setup();
    await queue.schedule(input());
    expect(queue.counts()).toEqual({ pending: 1, failed: 0 });
    expect(JSON.stringify(queue.counts())).not.toContain("BIOS");
  });
});
