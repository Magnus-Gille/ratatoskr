import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerReminderRoutes } from "../src/reminder-handler.js";
import { DurableReminderQueue } from "../src/reminders.js";

const NOW = Date.parse("2026-07-12T20:00:00Z");

async function makeApp(opts: { sendApiKey?: string; host?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-reminder-api-"));
  const queue = new DurableReminderQueue({
    storePath: path.join(dir, "reminders.json"),
    sendMessage: vi.fn(),
    now: () => NOW,
  });
  await queue.initialize();
  const app = express();
  registerReminderRoutes(app, {
    queue,
    allowedUsers: ["123"],
    sendApiKey: opts.sendApiKey ?? "secret",
    host: opts.host ?? "100.100.100.100",
  });
  return { app, queue };
}

const payload = {
  chat_id: 123,
  text: "check the BIOS",
  deliver_at: "2026-07-12T20:01:00Z",
  idempotency_key: "bios-check",
};

describe("reminder API", () => {
  let app: express.Express;
  let queue: DurableReminderQueue;

  beforeEach(async () => {
    ({ app, queue } = await makeApp());
  });

  it("authenticates before parsing JSON", async () => {
    const res = await request(app)
      .post("/api/reminders")
      .set("Content-Type", "application/json")
      .send("{broken");
    expect(res.status).toBe(401);
    expect(await queue.list()).toEqual([]);
  });

  it("allows the documented loopback-without-key posture", async () => {
    ({ app } = await makeApp({ sendApiKey: "", host: "127.0.0.1" }));
    const res = await request(app).post("/api/reminders").send(payload);
    expect(res.status).toBe(202);
  });

  it("accepts and persists a new reminder, then deduplicates a retry", async () => {
    const first = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send(payload);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      accepted: true,
      persisted: true,
      sent: false,
      deduplicated: false,
      reminder: { chat_id: 123, status: "pending" },
    });
    expect(first.body.reminder.text).toBeUndefined();

    const retry = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.deduplicated).toBe(true);
    expect(retry.body.reminder.id).toBe(first.body.reminder.id);
  });

  it("applies the chat allowlist and request validation", async () => {
    const forbidden = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send({ ...payload, chat_id: 999 });
    expect(forbidden.status).toBe(403);

    const invalid = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send({ ...payload, deliver_at: "yesterday" });
    expect(invalid.status).toBe(400);

    const missingText = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send({
        chat_id: payload.chat_id,
        deliver_at: payload.deliver_at,
        idempotency_key: payload.idempotency_key,
      });
    expect(missingText.status).toBe(400);
  });

  it("lists content-blind metadata, gets status, and cancels", async () => {
    const created = await request(app)
      .post("/api/reminders")
      .set("Authorization", "Bearer secret")
      .send(payload);
    const id = created.body.reminder.id;

    const list = await request(app)
      .get("/api/reminders?status=pending")
      .set("Authorization", "Bearer secret");
    expect(list.status).toBe(200);
    expect(list.body.reminders).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("check the BIOS");

    const status = await request(app)
      .get(`/api/reminders/${id}`)
      .set("Authorization", "Bearer secret");
    expect(status.body.reminder).toMatchObject({ id, status: "pending" });

    const cancelled = await request(app)
      .delete(`/api/reminders/${id}`)
      .set("Authorization", "Bearer secret");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.reminder.status).toBe("cancelled");
  });

  it("returns 404 for unknown ids and 400 for invalid status filters", async () => {
    const missing = await request(app)
      .get("/api/reminders/nope")
      .set("Authorization", "Bearer secret");
    expect(missing.status).toBe(404);
    const filter = await request(app)
      .get("/api/reminders?status=nope")
      .set("Authorization", "Bearer secret");
    expect(filter.status).toBe(400);
  });
});
