import { describe, it, expect } from "vitest";
import {
  shortId,
  extractResultBody,
  formatResult,
  stripMarkdown,
  STATUS_MESSAGES,
} from "../src/telegram-util.js";

const HUGIN_SUCCESS = `## Result

- **Exit code:** 0
- **Started at:** 2026-04-04T08:00:50.479Z
- **Completed at:** 2026-04-04T08:05:27.372Z
- **Duration:** 277s
- **Executor:** agent-sdk
- **Result source:** agent-sdk
- **Log file:** ~/.hugin/logs/20260404-example.log
- **Cost:** $0.86
- **Reply-to:** telegram:123456

### Response

Here is the actual answer that should reach Telegram.`;

const HUGIN_FAILURE = `## Result

- **Exit code:** 1
- **Started at:** 2026-04-04T08:00:50.479Z
- **Completed at:** 2026-04-04T08:01:10.479Z
- **Duration:** 20s
- **Executor:** agent-sdk

### Response

Error: could not find file foo.ts`;

const HUGIN_FAILURE_EMPTY = `## Result

- **Exit code:** 1
- **Started at:** 2026-04-04T08:00:50.479Z
- **Completed at:** 2026-04-04T08:01:10.479Z

### Response

`;

const NON_HUGIN_CONTENT = `Just some plain text result without any Hugin formatting.`;

describe("shortId", () => {
  it("extracts slug from standard task ID", () => {
    expect(shortId("20260404-153022-fix-navbar-css")).toBe("fix-navbar-css");
  });

  it("extracts multi-word slug", () => {
    expect(shortId("20260404-153022-update-heimdall-backup-script")).toBe(
      "update-heimdall-backup-script"
    );
  });

  it("returns full id if fewer than 3 segments", () => {
    expect(shortId("short")).toBe("short");
    expect(shortId("two-parts")).toBe("two-parts");
  });

  it("returns single slug segment", () => {
    expect(shortId("20260404-153022-task")).toBe("task");
  });
});

describe("extractResultBody", () => {
  it("extracts body from successful Hugin result", () => {
    const { body, failed } = extractResultBody(HUGIN_SUCCESS);
    expect(body).toBe("Here is the actual answer that should reach Telegram.");
    expect(failed).toBe(false);
  });

  it("extracts body from failed Hugin result", () => {
    const { body, failed } = extractResultBody(HUGIN_FAILURE);
    expect(body).toBe("Error: could not find file foo.ts");
    expect(failed).toBe(true);
  });

  it("detects empty body in failed result", () => {
    const { body, failed } = extractResultBody(HUGIN_FAILURE_EMPTY);
    expect(body).toBe("");
    expect(failed).toBe(true);
  });

  it("falls back gracefully for non-Hugin content", () => {
    const { body, failed } = extractResultBody(NON_HUGIN_CONTENT);
    expect(body).toBe(NON_HUGIN_CONTENT);
    expect(failed).toBe(false);
  });
});

describe("formatResult", () => {
  it("returns clean body for success", () => {
    const result = formatResult(HUGIN_SUCCESS, "20260404-153022-fix-navbar-css");
    expect(result).toContain("Here is the actual answer that should reach Telegram.");
    expect(result).not.toContain("Exit code");
    expect(result).not.toContain("Started at");
  });

  it("prefixes failure with terse message", () => {
    const result = formatResult(HUGIN_FAILURE, "20260404-153022-fix-navbar-css");
    expect(result).toContain("That didn't work.");
    expect(result).toContain("Error: could not find file foo.ts");
  });

  it("returns fallback for empty failure", () => {
    const result = formatResult(HUGIN_FAILURE_EMPTY, "20260404-153022-fix-navbar-css");
    expect(result).toContain("That failed. No output");
  });

  it("passes through non-Hugin content", () => {
    const result = formatResult(NON_HUGIN_CONTENT, "20260404-153022-fix-navbar-css");
    expect(result).toContain(NON_HUGIN_CONTENT);
  });

  it("always appends Munin footer", () => {
    const result = formatResult(HUGIN_SUCCESS, "20260404-153022-fix-navbar-css");
    expect(result).toContain("Full result in Munin.");
  });
});

describe("stripMarkdown", () => {
  it("removes headings", () => {
    expect(stripMarkdown("### Section Title\nContent")).toBe("Section Title\nContent");
    expect(stripMarkdown("# H1\n## H2\n### H3")).toBe("H1\nH2\nH3");
  });

  it("removes bold and italic", () => {
    expect(stripMarkdown("This is **bold** and *italic*")).toBe("This is bold and italic");
    expect(stripMarkdown("***bold italic***")).toBe("bold italic");
  });

  it("removes fenced code blocks", () => {
    expect(stripMarkdown("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripMarkdown("```\nplain code\n```")).toBe("plain code");
  });

  it("removes inline code backticks", () => {
    expect(stripMarkdown("Use `formatResult` here")).toBe("Use formatResult here");
  });

  it("removes links, keeps text", () => {
    expect(stripMarkdown("[click here](https://example.com)")).toBe("click here");
  });

  it("removes images, keeps alt text", () => {
    expect(stripMarkdown("![screenshot](img.png)")).toBe("screenshot");
  });

  it("removes blockquotes", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
  });

  it("removes horizontal rules", () => {
    expect(stripMarkdown("above\n---\nbelow")).toBe("above\n\nbelow");
  });

  it("removes strikethrough", () => {
    expect(stripMarkdown("~~deleted~~")).toBe("deleted");
  });

  it("removes unordered list markers", () => {
    expect(stripMarkdown("- item one\n- item two")).toBe("item one\nitem two");
    expect(stripMarkdown("* item one\n+ item two")).toBe("item one\nitem two");
  });

  it("collapses excessive blank lines", () => {
    expect(stripMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("handles a realistic Hugin response", () => {
    const markdown = `### Changes made

**Modified \`src/bot.ts\`:**
- Added error handling for \`null\` messages
- Fixed the ~~broken~~ retry logic

\`\`\`ts
const x = fixBug();
\`\`\`

See [the docs](https://example.com) for details.

---

All 31 tests pass.`;

    const plain = stripMarkdown(markdown);
    expect(plain).not.toContain("###");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("```");
    expect(plain).not.toContain("~~");
    expect(plain).not.toContain("[the docs]");
    expect(plain).toContain("Changes made");
    expect(plain).toContain("Modified src/bot.ts:");
    expect(plain).toContain("const x = fixBug();");
    expect(plain).toContain("the docs");
    expect(plain).toContain("All 31 tests pass.");
  });
});

describe("formatResult with markdown stripping", () => {
  it("strips markdown from successful Hugin responses", () => {
    const huginWithMarkdown = `## Result

- **Exit code:** 0
- **Started at:** 2026-04-04T08:00:50.479Z
- **Completed at:** 2026-04-04T08:05:27.372Z

### Response

### Summary

**Fixed** the \`navbar\` bug. See [PR #42](https://github.com/test/test/pull/42).

- Updated CSS
- Added tests`;

    const result = formatResult(huginWithMarkdown, "20260404-fix-navbar");
    expect(result).not.toContain("###");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`navbar`");
    expect(result).toContain("Fixed the navbar bug");
    expect(result).toContain("Updated CSS");
    expect(result).toContain("PR #42");
  });
});

describe("STATUS_MESSAGES", () => {
  it("cancelled includes short ID", () => {
    expect(STATUS_MESSAGES.cancelled("20260404-153022-fix-navbar-css")).toBe(
      "Cancelled fix-navbar-css."
    );
  });

  it("pollTimeout includes short ID and minutes", () => {
    expect(STATUS_MESSAGES.pollTimeout("20260404-153022-fix-navbar-css", 30)).toBe(
      "Lost track of fix-navbar-css after 30 min. Check Munin."
    );
  });

  it("completedFallback is terse", () => {
    expect(STATUS_MESSAGES.completedFallback).toBe("Done.");
  });

  it("failedFallback is terse", () => {
    expect(STATUS_MESSAGES.failedFallback).toContain("That failed.");
  });
});
