import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type GuidanceProbe = {
  id: string;
  kind: "retrieval" | "control";
  prompt: string;
  target: string;
  assert_regex?: string;
  question?: never;
  expected_doc?: never;
  expected_inline?: never;
  assertions?: never;
};

describe("project agent guidance", () => {
  it("keeps CLAUDE.md a thin adapter that imports the canonical AGENTS.md", async () => {
    const [claude, agents] = await Promise.all([
      readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
      readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    ]);

    expect(
      claude.startsWith("@AGENTS.md"),
      "CLAUDE.md must start with the @AGENTS.md import so both harnesses share one canonical guidance file"
    ).toBe(true);

    expect(
      agents.length,
      "AGENTS.md is the canonical guidance and must not be empty"
    ).toBeGreaterThan(0);

    expect(
      agents.includes("@AGENTS.md"),
      "AGENTS.md must not import itself — it is the canonical source, not an adapter"
    ).toBe(false);
  });

  it("indexes every guidance doc and keeps the M5 fallback rule inline", async () => {
    const docsDir = new URL("../docs/", import.meta.url);
    const [agents, docsIndex, probeSet, docEntries] = await Promise.all([
      readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/index.md", import.meta.url), "utf8"),
      readFile(new URL("./fixtures/agent-guidance-probes.json", import.meta.url), "utf8"),
      readdir(docsDir),
    ]);

    expect(
      agents.includes("docs/index.md"),
      "AGENTS.md must point to docs/index.md so extracted reference material stays discoverable"
    ).toBe(true);

    expect(
      agents.includes("Never drop a message"),
      "The M5 triage fallback contract must stay inline in AGENTS.md"
    ).toBe(true);

    expect(
      agents.includes("Strict parse on the local lane"),
      "The strict-parse M5 rule must stay inline in AGENTS.md"
    ).toBe(true);

    const markdownDocs = docEntries
      .filter((entry) => entry.endsWith(".md") && entry !== "index.md")
      .sort();

    for (const docName of markdownDocs) {
      expect(
        docsIndex.includes(docName),
        `docs/index.md must mention docs/${docName}`
      ).toBe(true);
    }

    const probes = JSON.parse(probeSet) as { probes: GuidanceProbe[] };

    for (const probe of probes.probes) {
      expect(probe.id.length, `probe ${probe.id} must have a stable id`).toBeGreaterThan(0);
      expect(probe.prompt.length, `probe ${probe.id} must have a frozen prompt`).toBeGreaterThan(0);

      expect("question" in probe, `probe ${probe.id} must use the historical harness prompt field`).toBe(false);
      expect("expected_doc" in probe, `probe ${probe.id} must use target, not expected_doc`).toBe(false);
      expect("expected_inline" in probe, `probe ${probe.id} must use target, not expected_inline`).toBe(false);
      expect("assertions" in probe, `probe ${probe.id} must use assert_regex, not assertions`).toBe(false);

      const targetBody = await readFile(
        new URL(`../${probe.target}`, import.meta.url),
        "utf8"
      );

      if (probe.kind === "retrieval") {
        expect(
          probe.target.startsWith("docs/"),
          `retrieval probe ${probe.id} must target a docs/ path`
        ).toBe(true);

        expect(
          docsIndex.includes(probe.target.replace("docs/", "")),
          `docs/index.md must mention ${probe.target} so the frozen probe target stays indexed`
        ).toBe(true);

        expect(
          probe.assert_regex,
          `retrieval probe ${probe.id} must not need an assert regex`
        ).toBeUndefined();
      } else {
        expect(probe.target).toBe("AGENTS.md");
        expect(
          probe.assert_regex,
          `control probe ${probe.id} must include a historical harness assert regex`
        ).toBeTypeOf("string");
        expect(
          new RegExp(probe.assert_regex ?? "", "i").test(targetBody),
          `control probe ${probe.id} assert_regex must match ${probe.target}`
        ).toBe(true);
      }
    }
  });
});
