import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("project agent guidance", () => {
  it("keeps the Claude and Codex guidance byte-for-byte synchronized", async () => {
    const [claude, agents] = await Promise.all([
      readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
      readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    ]);

    expect(
      agents,
      "AGENTS.md has drifted from CLAUDE.md — copy CLAUDE.md over AGENTS.md"
    ).toBe(claude);
  });
});
