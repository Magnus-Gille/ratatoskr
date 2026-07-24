import { readFile } from "node:fs/promises";
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
});
