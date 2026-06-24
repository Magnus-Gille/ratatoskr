import { describe, it, expect, vi } from "vitest";
import {
  renderAlertText,
  validateAlert,
  createHeimdallNotifier,
  type AlertEnvelope,
} from "../src/alert.js";

describe("validateAlert", () => {
  it("accepts a minimal envelope with just a title", () => {
    const alert = validateAlert({ title: "Disk full" });
    expect(alert).not.toBeNull();
    expect(alert?.title).toBe("Disk full");
  });

  it("accepts a full envelope and preserves all fields", () => {
    const input = {
      severity: "critical",
      source: "heimdall",
      title: "Pi down",
      body: "huginmunin unreachable",
      dedup_key: "pi-down",
      ts: "2026-06-24T08:00:00Z",
      links: [{ label: "dashboard", url: "https://example/d" }],
    };
    const alert = validateAlert(input);
    expect(alert).toEqual(input);
  });

  it("rejects a non-object", () => {
    expect(validateAlert("nope")).toBeNull();
    expect(validateAlert(42)).toBeNull();
    expect(validateAlert(null)).toBeNull();
    expect(validateAlert(undefined)).toBeNull();
    expect(validateAlert([])).toBeNull();
  });

  it("rejects an envelope without a title", () => {
    expect(validateAlert({ body: "no title" })).toBeNull();
  });

  it("rejects an envelope with an empty/whitespace title", () => {
    expect(validateAlert({ title: "" })).toBeNull();
    expect(validateAlert({ title: "   " })).toBeNull();
  });

  it("rejects an envelope with a non-string title", () => {
    expect(validateAlert({ title: 5 })).toBeNull();
  });

  it("keeps a known severity but drops an unknown/non-string one", () => {
    expect(validateAlert({ title: "T", severity: "warn" })?.severity).toBe(
      "warn"
    );
    expect(
      validateAlert({ title: "T", severity: "bogus" })?.severity
    ).toBeUndefined();
    expect(
      validateAlert({ title: "T", severity: 123 })?.severity
    ).toBeUndefined();
    expect(
      validateAlert({ title: "T", severity: { x: 1 } })?.severity
    ).toBeUndefined();
  });

  it("strips unknown fields — only the allowlisted envelope is forwarded", () => {
    const out = validateAlert({
      title: "T",
      body: "b",
      evil: "drop me",
      __proto__: { polluted: true },
    } as any);
    expect(out).toEqual({ title: "T", body: "b" });
    expect((out as any).evil).toBeUndefined();
  });

  it("drops wrong-typed optional fields (body/source/dedup_key/ts)", () => {
    const out = validateAlert({
      title: "T",
      body: 5,
      source: {},
      dedup_key: [],
      ts: 99,
    } as any);
    expect(out).toEqual({ title: "T" });
  });

  it("sanitizes links: keeps well-formed, drops malformed/empty entries", () => {
    const out = validateAlert({
      title: "T",
      links: [
        { label: "ok", url: "https://ok" },
        { label: "missing-url" },
        { label: "", url: "https://x" },
        { label: "x", url: "" },
        null,
        "str",
      ],
    } as any);
    expect(out?.links).toEqual([{ label: "ok", url: "https://ok" }]);
  });

  it("omits links entirely when none survive sanitization", () => {
    const out = validateAlert({ title: "T", links: [{ label: "x" }] } as any);
    expect(out).toEqual({ title: "T" });
  });

  it("drops links with unsafe URL schemes (javascript:/data:/file:)", () => {
    const out = validateAlert({
      title: "T",
      links: [
        { label: "xss", url: "javascript:alert(1)" },
        { label: "data", url: "data:text/html,<script>alert(1)</script>" },
        { label: "file", url: "file:///etc/passwd" },
        { label: "ok", url: "https://safe" },
      ],
    } as any);
    expect(out?.links).toEqual([{ label: "ok", url: "https://safe" }]);
  });

  it("drops links whose url is not a parseable URL", () => {
    const out = validateAlert({
      title: "T",
      links: [
        { label: "broken", url: "not a url" },
        { label: "ok", url: "http://ok" },
      ],
    } as any);
    expect(out?.links).toEqual([{ label: "ok", url: "http://ok" }]);
  });

  it("trims surrounding whitespace on kept link label/url", () => {
    const out = validateAlert({
      title: "T",
      links: [{ label: "  lab  ", url: "  https://ok  " }],
    } as any);
    expect(out?.links).toEqual([{ label: "lab", url: "https://ok" }]);
  });

  it("caps the number of links to a bounded maximum", () => {
    const links = Array.from({ length: 50 }, (_, i) => ({
      label: `l${i}`,
      url: `https://x/${i}`,
    }));
    const out = validateAlert({ title: "T", links } as any);
    expect(out?.links!.length).toBeLessThanOrEqual(10);
  });
});

describe("renderAlertText", () => {
  it("renders severity header + title", () => {
    expect(renderAlertText({ severity: "warn", title: "High load" })).toBe(
      "WARN — High load"
    );
  });

  it("defaults severity to INFO when absent", () => {
    expect(renderAlertText({ title: "Heads up" })).toBe("INFO — Heads up");
  });

  it("appends body on its own line", () => {
    expect(
      renderAlertText({ severity: "error", title: "Boom", body: "stack trace" })
    ).toBe("ERROR — Boom\nstack trace");
  });

  it("appends each link as 'label: url' lines after the body", () => {
    const out = renderAlertText({
      severity: "critical",
      title: "Pi down",
      body: "unreachable",
      links: [
        { label: "dashboard", url: "https://x/d" },
        { label: "logs", url: "https://x/l" },
      ],
    });
    expect(out).toBe(
      "CRITICAL — Pi down\nunreachable\ndashboard: https://x/d\nlogs: https://x/l"
    );
  });

  it("skips malformed link entries defensively", () => {
    const out = renderAlertText({
      title: "T",
      links: [
        { label: "ok", url: "https://ok" },
        { label: "missing-url" } as any,
        null as any,
        "string" as any,
      ],
    });
    expect(out).toBe("INFO — T\nok: https://ok");
  });

  it("omits the body line when body is empty", () => {
    expect(renderAlertText({ severity: "info", title: "T", body: "" })).toBe(
      "INFO — T"
    );
  });

  it("defaults a non-string severity to INFO (no [object Object])", () => {
    expect(
      renderAlertText({ title: "T", severity: { x: 1 } as any })
    ).toBe("INFO — T");
  });

  it("self-bounds the rendered text to Telegram's 4096-char limit", () => {
    const out = renderAlertText({ title: "T", body: "x".repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("createHeimdallNotifier", () => {
  const alert: AlertEnvelope = {
    severity: "warn",
    source: "ratatoskr",
    title: "Test",
    body: "b",
    dedup_key: "k1",
  };

  it("POSTs the bare alert with bearer auth + json content-type", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const notify = createHeimdallNotifier({
      url: "http://heimdall:3033/api/alerts",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notify(alert);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://heimdall:3033/api/alerts");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual(alert);
    // dedup_key passthrough
    expect(JSON.parse(init.body).dedup_key).toBe("k1");
    // Real abort wiring, not just "defined" — pins the timeout signal.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("wires AbortSignal.timeout with the default 3000ms when unset", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const notify = createHeimdallNotifier({
      url: "http://h/api/alerts",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notify(alert);
    expect(spy).toHaveBeenCalledWith(3000);
    spy.mockRestore();
  });

  it("wires AbortSignal.timeout with a configured timeoutMs", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const notify = createHeimdallNotifier({
      url: "http://h/api/alerts",
      token: "t",
      timeoutMs: 1234,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notify(alert);
    expect(spy).toHaveBeenCalledWith(1234);
    spy.mockRestore();
  });

  it("throws on a non-2xx response (so the caller can log)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 } as Response);
    const notify = createHeimdallNotifier({
      url: "http://h/api/alerts",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(notify(alert)).rejects.toThrow(/401/);
  });

  it("propagates a network/timeout rejection", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const notify = createHeimdallNotifier({
      url: "http://h/api/alerts",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(notify(alert)).rejects.toThrow(/ETIMEDOUT/);
  });
});
