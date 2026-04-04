import { describe, it, expect } from "vitest";
import {
  shortId,
  extractResultBody,
  formatResult,
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
