import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** These are transitive dependency regressions, not proof of app reachability. */
const require = createRequire(import.meta.url);
const expressRequire = createRequire(require.resolve("express"));
const bodyParserRequire = createRequire(expressRequire.resolve("body-parser"));
const proxyaddr = expressRequire("proxy-addr") as {
  compile: (range: string) => (address: string, index?: number) => boolean;
};
type QsModule = {
  stringify: (value: unknown, options?: Record<string, unknown>) => string;
};
const qsModules = new Map<string, QsModule>([
  [expressRequire.resolve("qs"), expressRequire("qs") as QsModule],
  [bodyParserRequire.resolve("qs"), bodyParserRequire("qs") as QsModule],
]);

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/compressed-json-probe.ts"
);

interface ProbeResult {
  route: "send" | "reminder";
  bodyKind: "plain" | "trailing-auth" | "trailing-unauth";
  status: number;
  body: string;
  messageCalls: Array<[number, string]>;
}

async function runProbe(
  route: ProbeResult["route"],
  bodyKind: ProbeResult["bodyKind"]
): Promise<ProbeResult> {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, route, bodyKind], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const timeout = setTimeout(() => child.kill("SIGKILL"), 4_000);
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  clearTimeout(timeout);

  const errorOutput = stderr.length ? ` stderr=${Buffer.concat(stderr).toString("utf8")}` : "";
  expect(code, `compressed JSON probe ${route}/${bodyKind} crashed (${signal ?? "unknown"}).${errorOutput}`).toBe(0);
  expect(signal, `compressed JSON probe ${route}/${bodyKind} timed out.${errorOutput}`).toBeNull();
  const output = Buffer.concat(stdout).toString("utf8");
  expect(output, `compressed JSON probe ${route}/${bodyKind} returned no result.${errorOutput}`).not.toBe("");
  const result = JSON.parse(output) as ProbeResult;
  expect(result.body, `compressed JSON probe ${route}/${bodyKind} returned an empty HTTP response`).not.toBe("");
  return result;
}

describe("transitive dependency security regressions", () => {
  it("proxy-addr does not widen IPv4-mapped trust ranges", () => {
    expect(proxyaddr.compile("::ffff:10.0.0.0/8")("198.51.100.10")).toBe(false);
    expect(proxyaddr.compile("::/1")("198.51.100.10")).toBe(false);
    expect(proxyaddr.compile("10.0.0.0/8")("10.1.2.3")).toBe(true);
    expect(proxyaddr.compile("::ffff:10.0.0.0/104")("10.1.2.3")).toBe(true);
  });

  it("qs.stringify tolerates hostile comma-array values in both encoder paths", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    const nonCallableToString = { toString: "not-callable" };
    for (const [resolvedPath, qs] of qsModules) {
      for (const value of [nullPrototype, nonCallableToString]) {
        expect(
          () => qs.stringify({ value: [value] }, { arrayFormat: "comma" }),
          `${resolvedPath}: default comma encoding threw`
        ).not.toThrow();
        expect(
          () => qs.stringify({ value: [value] }, {
            arrayFormat: "comma",
            encodeValuesOnly: true,
          }),
          `${resolvedPath}: encodeValuesOnly comma encoding threw`
        ).not.toThrow();
      }
      expect(qs.stringify({ value: "ordinary" }, { arrayFormat: "comma" })).toBe("value=ordinary");
      expect(qs.stringify({ value: ["one", "two"] }, { arrayFormat: "comma" })).toBe("value=one%2Ctwo");
    }
  });

  it("keeps authenticated compressed /api/send alive after trailing bytes", async () => {
    const plain = await runProbe("send", "plain");
    expect(plain.status).toBe(200);
    expect(plain.messageCalls).toEqual([[42, "hello"]]);

    const trailing = await runProbe("send", "trailing-auth");
    expect(trailing.status).toBe(200);
    expect(trailing.messageCalls).toEqual([[42, "hello"]]);

    const unauthenticated = await runProbe("send", "trailing-unauth");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.messageCalls).toEqual([]);
  }, 15_000);

  it("keeps authenticated compressed reminder POST alive after trailing bytes", async () => {
    const plain = await runProbe("reminder", "plain");
    expect(plain.status).toBe(202);
    expect(plain.messageCalls).toEqual([]);

    const trailing = await runProbe("reminder", "trailing-auth");
    expect(trailing.status).toBe(202);
    expect(trailing.messageCalls).toEqual([]);

    const unauthenticated = await runProbe("reminder", "trailing-unauth");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.messageCalls).toEqual([]);
  }, 15_000);
});
