import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerSendRoute, createSendHandler } from "../src/send-handler.js";

interface AppOverrides {
  sendMessage?: ReturnType<typeof vi.fn>;
  logError?: ReturnType<typeof vi.fn>;
  allowedUsers?: string[];
  sendApiKey?: string;
  host?: string;
}

function makeApp(overrides: AppOverrides = {}) {
  const sendMessage =
    overrides.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const logError = overrides.logError ?? vi.fn();
  const app = express();
  registerSendRoute(app, {
    sendMessage,
    logError,
    allowedUsers: overrides.allowedUsers ?? ["123"],
    sendApiKey: overrides.sendApiKey ?? "", // default: no key
    host: overrides.host ?? "127.0.0.1", // default: loopback → auth passes through
  });
  return { app, sendMessage, logError };
}

// Mock req/res for direct unit tests of the handler (mirrors auth.test.ts style).
function makeRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

describe("POST /api/send route (integration via registerSendRoute)", () => {
  // --- Happy path -----------------------------------------------------------
  it("valid chat_id + text → 200 {ok:true} and forwards to sendMessage", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: 123, text: "hello" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(123, "hello");
  });

  // --- 400 validation -------------------------------------------------------
  it("missing text → 400, sendMessage not called", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app).post("/api/send").send({ chat_id: 123 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "chat_id (number) and text (string) are required",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("missing chat_id (text present) → 400, sendMessage not called", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app).post("/api/send").send({ text: "hello" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "chat_id (number) and text (string) are required",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("chat_id sent as a string → 400 (type guard, not coerced)", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: "123", text: "hello" });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("empty text → 400", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: 123, text: "" });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("non-string text → 400", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: 123, text: 5 });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("empty/no body → 400 (handler tolerates undefined body, no crash)", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app).post("/api/send");
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // --- 403 authorization ----------------------------------------------------
  it("chat_id not in allowedUsers → 403, sendMessage not called", async () => {
    const { app, sendMessage } = makeApp({ allowedUsers: ["123"] });
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: 999, text: "hello" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "chat_id not in allowed users list" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // --- 500 send failure -----------------------------------------------------
  it("sendMessage throws → 500 and logs via injected logError", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const { app, logError } = makeApp({ sendMessage });
    const res = await request(app)
      .post("/api/send")
      .send({ chat_id: 123, text: "hello" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("boom");
    expect(logError).toHaveBeenCalledOnce();
  });

  // --- Body parsing ---------------------------------------------------------
  it("malformed JSON body (auth passing) → 400 from express.json(), distinct from handler's JSON 400", async () => {
    const { app, sendMessage } = makeApp();
    const res = await request(app)
      .post("/api/send")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    expect(res.status).toBe(400);
    // express.json()'s parse-error 400 carries an HTML body, NOT the handler's
    // JSON envelope. This discriminates the two 400 sources: if express.json()
    // were removed, req.body would be undefined and the handler would return THIS
    // exact envelope — so the assertion fails (red), proving the parser is mounted.
    expect(res.body).not.toEqual({
      error: "chat_id (number) and text (string) are required",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("GET /api/send → 404 (route is POST-only)", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/send");
    expect(res.status).toBe(404);
  });

  // --- Auth runs BEFORE json parsing (the "json-parsed-after-auth" property) -
  it("non-loopback bind + no key + MALFORMED body → 401 (auth gates the parser even with no key set)", async () => {
    // Malformed body is deliberate: if express.json() ran before auth, this would
    // surface as a 400 parse error. Getting the 401 fail-closed response instead
    // proves auth runs first on the no-key branch too.
    const { app, sendMessage } = makeApp({ host: "0.0.0.0", sendApiKey: "" });
    const res = await request(app)
      .post("/api/send")
      .set("Content-Type", "application/json")
      .send("{malformed");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error:
        "Send API key not configured; endpoint disabled on non-loopback bind",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keyed bind + missing Bearer + MALFORMED body → 401 (auth), not 400 (parser) — proves auth gates the JSON parser", async () => {
    const { app, sendMessage } = makeApp({
      host: "0.0.0.0",
      sendApiKey: "s3cret",
    });
    const res = await request(app)
      .post("/api/send")
      .set("Content-Type", "application/json")
      .send("{malformed"); // would be a 400 if json() ran first
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keyed bind + valid Bearer + valid payload → 200 (production remote-send shape)", async () => {
    const { app, sendMessage } = makeApp({
      host: "0.0.0.0",
      sendApiKey: "s3cret",
      allowedUsers: ["123"],
    });
    const res = await request(app)
      .post("/api/send")
      .set("Authorization", "Bearer s3cret")
      .send({ chat_id: 123, text: "hello" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(123, "hello");
  });
});

describe("createSendHandler (unit)", () => {
  it("falls back to console.error when no logError is injected", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createSendHandler({
      sendMessage: vi.fn().mockRejectedValue(new Error("x")),
      allowedUsers: ["123"],
    });
    const res = makeRes();
    await handler({ body: { chat_id: 123, text: "hi" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
