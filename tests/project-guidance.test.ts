import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

    const probes = JSON.parse(probeSet) as {
      probes: Array<
        | { kind: "retrieval"; expected_doc: string }
        | { kind: "control"; expected_inline: string }
      >;
    };

    for (const probe of probes.probes) {
      if (probe.kind === "retrieval") {
        expect(
          docsIndex.includes(probe.expected_doc.replace("docs/", "")),
          `docs/index.md must mention ${probe.expected_doc} so the frozen probe target stays indexed`
        ).toBe(true);
      } else {
        expect(probe.expected_inline).toBe("AGENTS.md");
      }
    }
  });
});
