import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIGNATURE_VERSION,
  buildCanonicalPayload,
  inspectSignatureField,
  setTaskSignature,
  signTask,
  verifyTaskSignature,
} from "../src/task-signing.js";
import { submitTask } from "../src/task-writer.js";
import { config } from "../src/config.js";
import * as pinnedHuginVerifier from "./fixtures/hugin-v2/task-signing.ts";

const SECRET = "a".repeat(64);
const TASK_ID = "20260423-120000-fixture";
const SUBMITTED_AT = "2026-04-23T12:00:00Z";
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/hugin-v2");
const UNSIGNED = `## Task\n\n**Runtime:** claude\n**Context:** scratch\n**Timeout:** 300000\n**Submitted by:** ratatoskr\n**Submitted at:** ${SUBMITTED_AT}\n**Reply-to:** telegram:123\n\n### Prompt\n\nDo the thing.\n`;

function signedBody(body = UNSIGNED): string {
  const signature = signTask(
    { taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: body },
    "ratatoskr",
    SECRET,
  );
  return setTaskSignature(body, signature);
}

function verify(body: string) {
  return verifyTaskSignature(
    { taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: body },
    { ratatoskr: SECRET },
  );
}

describe("task-signing v2", () => {
  it("signs the complete task body and emits v2", () => {
    const signature = signTask(
      { taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: UNSIGNED },
      "ratatoskr",
      SECRET,
    );
    expect(signature).toMatch(/^v2:ratatoskr:[0-9a-f]{64}$/);
    expect(signature.split(":")[0]).toBe(SIGNATURE_VERSION);
    expect(buildCanonicalPayload({ taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: UNSIGNED }))
      .toContain("task-body-sha256=");
  });

  it("inserts the signature immediately before the metadata separator", () => {
    const body = signedBody();
    expect(body).toContain("**Reply-to:** telegram:123\n- **Signature:** v2:ratatoskr:");
    expect(body.indexOf("- **Signature:**")).toBeLessThan(body.indexOf("### Prompt"));
  });

  it("normalizes CRLF only for canonical hashing and preserves it when inserting", () => {
    const crlf = UNSIGNED.replaceAll("\n", "\r\n");
    const signature = signTask(
      { taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: crlf },
      "ratatoskr",
      SECRET,
    );
    const inserted = setTaskSignature(crlf, signature);
    expect(inserted).toContain("\r\n- **Signature:** v2:ratatoskr:");
    expect(inserted).toContain("\r\n### Prompt");
    expect(verify(inserted).status).toBe("valid");
  });

  it.each([
    ["context", "**Context:** repo:other"],
    ["timeout", "**Timeout:** 999999"],
    ["reply-to", "**Reply-to:** telegram:999"],
    ["preamble", "**Runtime:** shell"],
    ["new field", "**New field:** changed"],
  ])("rejects a forged %s", (_label, replacement) => {
    const patterns: Record<string, RegExp> = {
      context: /\*\*Context:\*\* [^\n]+/,
      timeout: /\*\*Timeout:\*\* [^\n]+/,
      "reply-to": /\*\*Reply-to:\*\* [^\n]+/,
      preamble: /\*\*Runtime:\*\* [^\n]+/,
      "new field": /### Prompt/,
    };
    const body = signedBody().replace(patterns[_label], replacement);
    expect(verify(body).status).not.toBe("valid");
  });

  it("rejects a moved signature and duplicate or malformed prefix fields", () => {
    const body = signedBody();
    const line = body.match(/- \*\*Signature:\*\* v2:[^\n]+/)?.[0];
    expect(line).toBeTruthy();
    const moved = body.replace(`${line}\n`, "").replace("### Prompt", `${line}\n### Prompt`);
    expect((moved.match(/\*\*Signature:\*\*/g) ?? [])).toHaveLength(1);
    expect(verify(moved).status).not.toBe("valid");

    const duplicate = body.replace("### Prompt", `${line}\n### Prompt`);
    expect(inspectSignatureField(duplicate).status).toBe("malformed");
    expect(inspectSignatureField(body.replace(/v2:ratatoskr:[0-9a-f]+/, "v2:ratatoskr:not-hex")).status).toBe("malformed");
  });

  it("keeps Signature-looking prompt text as data", () => {
    const body = signedBody(`${UNSIGNED}**Signature:** v2:prompt:data\n`);
    expect(verify(body).status).toBe("valid");
    expect(inspectSignatureField(`${UNSIGNED}**Signature:** v2:prompt:data\n`).status).toBe("missing");
  });

  it("never falls back to v1", () => {
    const body = UNSIGNED.replace("### Prompt", "- **Signature:** v1:ratatoskr:" + "a".repeat(64) + "\n\n### Prompt");
    expect(verify(body).status).toBe("unsupported-version");
  });

  it("matches the pinned Hugin helper and verifier fixture", async () => {
    const helper = path.join(FIXTURE_DIR, "sign-task.mjs");
    const verifierSource = path.join(FIXTURE_DIR, "task-signing.ts");
    expect(fs.existsSync(helper)).toBe(true);
    expect(fs.existsSync(verifierSource)).toBe(true);
    expect(createHash("sha256").update(fs.readFileSync(verifierSource)).digest("hex"))
      .toBe("0b9d34cdc51170d9ac3cbb3e0b623aff53b8a4272000604294169a33e068e569");
    expect(createHash("sha256").update(fs.readFileSync(helper)).digest("hex"))
      .toBe("5381ff34886757267cfee91ba8baa15a52d34b814239deedb17ed71b6c13183c");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratatoskr-v2-"));
    const taskFile = path.join(tmp, "task.md");
    const home = path.join(tmp, "home");
    const scratch = path.join(tmp, "scratch");
    fs.mkdirSync(home);
    fs.mkdirSync(scratch);
    fs.writeFileSync(taskFile, UNSIGNED);
    const result = spawnSync(process.execPath, [helper, "--task-file", taskFile, "--task-id", TASK_ID, "--key-id", "ratatoskr"], {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, HUGIN_SIGNING_SECRET: SECRET },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const helperSignature = result.stdout.trim();
    expect(helperSignature).toBe(signTask({ taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: UNSIGNED }, "ratatoskr", SECRET));

    const produced = setTaskSignature(UNSIGNED, helperSignature);
    expect(pinnedHuginVerifier.verifyTaskSignature({ taskId: TASK_ID, submitter: "ratatoskr", submittedAt: SUBMITTED_AT, taskBody: produced }, { ratatoskr: SECRET }).status).toBe("valid");

    const previousSecret = config.signingSecret;
    const previousKeyId = config.signingKeyId;
    const writes: unknown[][] = [];
    config.signingSecret = SECRET;
    config.signingKeyId = "ratatoskr";
    try {
      await submitTask(
        { title: "Fixture compatibility", prompt: "Use the complete task document.", context: "repo:hugin", timeout: 300, chatId: "123" },
        { write: async (...args: unknown[]) => { writes.push(args); } } as never,
      );
    } finally {
      config.signingSecret = previousSecret;
      config.signingKeyId = previousKeyId;
    }
    const [namespace, , actualBody] = writes[0] as [string, string, string];
    const actualTaskId = namespace.slice("tasks/".length);
    const metadata = pinnedHuginVerifier.extractTaskSigningMetadata(actualBody);
    expect(pinnedHuginVerifier.verifyTaskSignature({ taskId: actualTaskId, submitter: metadata.submitter, submittedAt: metadata.submittedAt, taskBody: actualBody }, { ratatoskr: SECRET }).status).toBe("valid");
    for (const mutation of [
      ["Context", "repo:scratch"],
      ["Timeout", "999999"],
      ["Reply-to", "telegram:999"],
      ["Runtime", "shell"],
    ] as const) {
      const tampered = actualBody.replace(new RegExp(`\\*\\*${mutation[0]}:\\*\\* [^\\n]+`), `**${mutation[0]}:** ${mutation[1]}`);
      expect(pinnedHuginVerifier.verifyTaskSignature({ taskId: actualTaskId, submitter: metadata.submitter, submittedAt: metadata.submittedAt, taskBody: tampered }, { ratatoskr: SECRET }).status).not.toBe("valid");
    }
    const newField = actualBody.replace("### Prompt", "**New field:** forged\n\n### Prompt");
    expect(pinnedHuginVerifier.verifyTaskSignature({ taskId: actualTaskId, submitter: metadata.submitter, submittedAt: metadata.submittedAt, taskBody: newField }, { ratatoskr: SECRET }).status).not.toBe("valid");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
