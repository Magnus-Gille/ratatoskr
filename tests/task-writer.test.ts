import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    instanceId: "test-instance",
    reposBasePath: "/home/magnus/repos",
    signingSecret: "",
    signingKeyId: "ratatoskr",
  },
}));

import { submitTask } from "../src/task-writer.js";
import type { MuninClient } from "../src/munin-client.js";
import { config } from "../src/config.js";

function mockMunin(): MuninClient & { write: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(true),
  } as unknown as MuninClient & { write: ReturnType<typeof vi.fn> };
}

describe("task-writer", () => {
  it("should generate a task ID with correct format", async () => {
    const munin = mockMunin();
    const taskId = await submitTask(
      {
        title: "Fix Navbar CSS",
        prompt: "Fix the navbar CSS layout bug",
        context: "repo:heimdall",
        timeout: 300,
        chatId: "12345",
      },
      munin
    );

    expect(taskId).toMatch(/^\d{8}-\d{6}-fix-navbar-css$/);
  });

  it("should write task markdown with correct schema", async () => {
    const munin = mockMunin();
    await submitTask(
      {
        title: "Fix Bug",
        prompt: "Fix the login bug",
        context: "repo:heimdall",
        timeout: 600,
        chatId: "12345",
      },
      munin
    );

    expect(munin.write).toHaveBeenCalledTimes(1);
    const [namespace, key, content, tags] = munin.write.mock.calls[0];

    expect(namespace).toMatch(/^tasks\//);
    expect(key).toBe("status");
    expect(content).toContain("**Runtime:** claude");
    expect(content).toContain("**Context:** repo:heimdall");
    expect(content).toContain("**Timeout:** 600000");
    expect(content).toContain("**Submitted by:** ratatoskr");
    expect(content).toContain("**Reply-to:** telegram:12345");
    expect(content).toContain("### Prompt");
    expect(content).toContain("Fix the login bug");
    expect(tags).toEqual(["pending", "runtime:claude", "instance:test-instance"]);
  });

  it("should omit **Signature:** line when no signing secret is configured", async () => {
    const munin = mockMunin();
    await submitTask(
      {
        title: "Unsigned",
        prompt: "noop",
        context: "scratch",
        timeout: 300,
        chatId: "1",
      },
      munin,
    );
    const content = munin.write.mock.calls[0][2] as string;
    expect(content).not.toContain("**Signature:**");
  });

  it("should embed a **Signature:** line when signing secret is configured", async () => {
    const prev = { secret: config.signingSecret, keyId: config.signingKeyId };
    config.signingSecret = "a".repeat(64);
    config.signingKeyId = "ratatoskr";
    try {
      const munin = mockMunin();
      await submitTask(
        {
          title: "Signed",
          prompt: "noop",
          context: "scratch",
          timeout: 300,
          chatId: "1",
        },
        munin,
      );
      const content = munin.write.mock.calls[0][2] as string;
      expect(content).toMatch(/\*\*Signature:\*\* v1:ratatoskr:[0-9a-f]{64}/);
    } finally {
      config.signingSecret = prev.secret;
      config.signingKeyId = prev.keyId;
    }
  });

  it("should slugify title for task ID", async () => {
    const munin = mockMunin();
    const taskId = await submitTask(
      {
        title: "Add User Authentication & Login Flow!!!",
        prompt: "Add auth",
        context: "scratch",
        timeout: 1800,
        chatId: "99",
      },
      munin
    );

    // Should be slugified: lowercase, special chars replaced
    expect(taskId).toMatch(/^\d{8}-\d{6}-add-user-authentication-login-flow/);
  });
});
