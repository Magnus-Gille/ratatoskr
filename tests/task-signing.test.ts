import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SIGNATURE_VERSION,
  buildCanonicalPayload,
  canonicalizePrompt,
  signTask,
} from "../src/task-signing.js";

const SECRET = "a".repeat(64);

const BASE = {
  taskId: "20260423-120000-fixture",
  submitter: "ratatoskr",
  submittedAt: "2026-04-23T12:00:00Z",
  runtime: "claude",
  prompt: "Do the thing.",
};

describe("task-signing", () => {
  it("canonicalizePrompt trims surrounding whitespace", () => {
    expect(canonicalizePrompt("  hello  \n")).toBe("hello");
  });

  it("buildCanonicalPayload sorts fields and ends with newline", () => {
    const payload = buildCanonicalPayload(BASE);
    const lines = payload.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    const keys = lines.slice(0, -1).map((l) => l.split("=")[0]);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("prompt-sha256");
    expect(keys).toContain("task-id");
    expect(keys).toContain("version");
  });

  it("buildCanonicalPayload omits context-refs when list is empty", () => {
    const payload = buildCanonicalPayload(BASE);
    expect(payload).toContain("context-refs-sha256=\n");
  });

  it("signTask yields a deterministic v1 signature", () => {
    const sig = signTask(BASE, "ratatoskr", SECRET);
    const [version, keyId, hex] = sig.split(":");
    expect(version).toBe(SIGNATURE_VERSION);
    expect(keyId).toBe("ratatoskr");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signTask(BASE, "ratatoskr", SECRET));
  });

  it("signTask changes when prompt changes", () => {
    const a = signTask(BASE, "ratatoskr", SECRET);
    const b = signTask({ ...BASE, prompt: "Do the other thing." }, "ratatoskr", SECRET);
    expect(a).not.toBe(b);
  });

  it("signTask changes when context-refs change", () => {
    const a = signTask({ ...BASE, contextRefs: ["a/x"] }, "ratatoskr", SECRET);
    const b = signTask({ ...BASE, contextRefs: ["a/x", "b/y"] }, "ratatoskr", SECRET);
    expect(a).not.toBe(b);
  });

  it("context-refs order does not matter (sorted canonicalization)", () => {
    const a = signTask({ ...BASE, contextRefs: ["a/x", "b/y"] }, "ratatoskr", SECRET);
    const b = signTask({ ...BASE, contextRefs: ["b/y", "a/x"] }, "ratatoskr", SECRET);
    expect(a).toBe(b);
  });

  // Cross-language drift guard: invoke hugin's scripts/sign-task.mjs with the
  // same inputs and assert identical output. Skips automatically when the
  // helper is not available (e.g. CI checkout without hugin alongside).
  describe("cross-drift with hugin/scripts/sign-task.mjs", () => {
    const helper =
      process.env.HUGIN_SIGN_TASK_HELPER ||
      path.resolve(process.cwd(), "..", "hugin", "scripts", "sign-task.mjs");
    const available = fs.existsSync(helper);

    it.runIf(available)("matches signTask output byte-for-byte", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratatoskr-sign-"));
      const promptFile = path.join(tmp, "prompt.md");
      fs.writeFileSync(promptFile, BASE.prompt);

      const result = spawnSync(
        process.execPath,
        [
          helper,
          "--task-id", BASE.taskId,
          "--submitter", BASE.submitter,
          "--submitted-at", BASE.submittedAt,
          "--runtime", BASE.runtime,
          "--prompt-file", promptFile,
          "--key-id", "ratatoskr",
        ],
        {
          env: { ...process.env, HUGIN_SIGNING_SECRET: SECRET },
          encoding: "utf8",
        },
      );
      fs.rmSync(tmp, { recursive: true, force: true });

      expect(result.status, result.stderr).toBe(0);
      const expected = signTask(BASE, "ratatoskr", SECRET);
      expect(result.stdout.trim()).toBe(expected);
    });

    it.runIf(available)("matches signTask output with context-refs", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratatoskr-sign-"));
      const promptFile = path.join(tmp, "prompt.md");
      fs.writeFileSync(promptFile, BASE.prompt);

      const result = spawnSync(
        process.execPath,
        [
          helper,
          "--task-id", BASE.taskId,
          "--submitter", BASE.submitter,
          "--submitted-at", BASE.submittedAt,
          "--runtime", BASE.runtime,
          "--prompt-file", promptFile,
          "--context-refs", "projects/hugin/status,meta/conventions/status",
          "--key-id", "ratatoskr",
        ],
        {
          env: { ...process.env, HUGIN_SIGNING_SECRET: SECRET },
          encoding: "utf8",
        },
      );
      fs.rmSync(tmp, { recursive: true, force: true });

      expect(result.status, result.stderr).toBe(0);
      const expected = signTask(
        {
          ...BASE,
          contextRefs: ["projects/hugin/status", "meta/conventions/status"],
        },
        "ratatoskr",
        SECRET,
      );
      expect(result.stdout.trim()).toBe(expected);
    });
  });
});
