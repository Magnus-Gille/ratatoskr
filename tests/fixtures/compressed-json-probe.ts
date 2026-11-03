import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import express from "express";
import { registerReminderRoutes } from "../../src/reminder-handler.js";
import { DurableReminderQueue } from "../../src/reminders.js";
import { registerSendRoute } from "../../src/send-handler.js";

type ProbeRoute = "send" | "reminder";
type ProbeBody = "plain" | "trailing-auth" | "trailing-unauth";

const route = process.argv[2] as ProbeRoute;
const bodyKind = process.argv[3] as ProbeBody;

if (!((route === "send" || route === "reminder") &&
  (bodyKind === "plain" || bodyKind === "trailing-auth" || bodyKind === "trailing-unauth"))) {
  throw new Error(`unsupported probe arguments: ${route} ${bodyKind}`);
}

const messageCalls: Array<[number, string]> = [];
const app = express();
const sendMessage = async (chatId: number, text: string): Promise<void> => {
  messageCalls.push([chatId, text]);
};

let reminders: DurableReminderQueue | undefined;
let reminderStoreDir: string | undefined;
if (route === "send") {
  registerSendRoute(app, {
    sendMessage,
    allowedUsers: ["42"],
    sendApiKey: "probe-key",
    host: "127.0.0.1",
  });
} else {
  reminderStoreDir = await mkdtemp(path.join(os.tmpdir(), "ratatoskr-compressed-json-"));
  reminders = new DurableReminderQueue({
    storePath: path.join(reminderStoreDir, "reminders.json"),
    sendMessage,
  });
  await reminders.initialize();
  registerReminderRoutes(app, {
    queue: reminders,
    allowedUsers: ["42"],
    sendApiKey: "probe-key",
    host: "127.0.0.1",
  });
}

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));

const payload = route === "send"
  ? { chat_id: 42, text: "hello" }
  : {
      chat_id: 42,
      text: "hello",
      deliver_at: new Date(Date.now() + 60_000).toISOString(),
      idempotency_key: `compressed-json-${process.pid}`,
    };
const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
const body = bodyKind === "plain"
  ? compressed
  : Buffer.concat([compressed, Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);

let response: { status: number; body: string };
try {
  response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
      method: "POST",
      path: route === "send" ? "/api/send" : "/api/reminders",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": body.length,
        ...(bodyKind === "trailing-unauth"
          ? {}
          : { Authorization: "Bearer probe-key" }),
        Connection: "close",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end(body);
  });

  // body-parser's vulnerable path reports success before the trailing bytes reach
  // the finished decoder. Keep the child alive long enough for that late error to
  // become an uncaught process failure instead of hiding it behind a fast exit.
  await new Promise((resolve) => setTimeout(resolve, 200));
} finally {
  reminders?.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (reminderStoreDir) {
    await rm(reminderStoreDir, { recursive: true, force: true });
  }
}

process.stdout.write(JSON.stringify({
  route,
  bodyKind,
  status: response.status,
  body: response.body,
  messageCalls,
}));
