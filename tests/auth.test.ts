import { describe, it, expect, vi } from "vitest";
import { requireSendApiKey } from "../src/auth.js";

function makeRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

function makeReq(authorization?: string): any {
  return {
    headers: authorization !== undefined ? { authorization } : {},
  };
}

describe("requireSendApiKey", () => {
  it("(a) no key + loopback → next called", () => {
    const mw = requireSendApiKey("", "127.0.0.1");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(b) no key + non-loopback (0.0.0.0) → 401", () => {
    const mw = requireSendApiKey("", "0.0.0.0");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error:
        "Send API key not configured; endpoint disabled on non-loopback bind",
    });
  });

  it("(c) valid Bearer on keyed → next called", () => {
    const mw = requireSendApiKey("mysecret", "0.0.0.0");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("Bearer mysecret"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(d) wrong Bearer → 401", () => {
    const mw = requireSendApiKey("mysecret", "0.0.0.0");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("Bearer wrongtoken"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("(e) missing Bearer header on keyed → 401", () => {
    const mw = requireSendApiKey("mysecret", "127.0.0.1");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("(f) prefix match 'Bearer secret' vs key 'secret123' → 401 (length guard)", () => {
    const mw = requireSendApiKey("secret123", "0.0.0.0");
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq("Bearer secret"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });
});
