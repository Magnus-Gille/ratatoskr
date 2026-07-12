import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const helper = path.resolve("scripts/ratatoskr");

async function fixture(env: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-send-"));
  const envFile = path.join(dir, ".env");
  const captureFile = path.join(dir, "curl-args");
  const fakeCurl = path.join(dir, "curl");
  await writeFile(envFile, env);
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env bash
config="$(cat)"
{
  printf 'CONFIG=%s\\n' "$config"
  printf 'ARG=%s\\n' "$@"
} > "$CAPTURE_FILE"
output=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "--output" ]]; then output="$arg"; fi
  previous="$arg"
done
if [[ -n "$output" && -n "\${FAKE_CURL_BODY:-}" ]]; then
  printf '%s' "$FAKE_CURL_BODY" > "$output"
fi
exit "\${FAKE_CURL_EXIT:-0}"
`
  );
  await chmod(fakeCurl, 0o755);
  return { envFile, captureFile, fakeCurl };
}

describe("scripts/ratatoskr send", () => {
  it("sends directly through Telegram with the first allowlisted chat", async () => {
    const f = await fixture(
      "UNRELATED=hello world\nTELEGRAM_BOT_TOKEN=123:test-token\nTELEGRAM_ALLOWED_USERS=12345,67890\n"
    );
    const result = spawnSync(helper, ["send", "hello", "from", "tests"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RATATOSKR_CHAT_ID: "",
        RATATOSKR_ENV_FILE: f.envFile,
        RATATOSKR_CURL_BIN: f.fakeCurl,
        CAPTURE_FILE: f.captureFile,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const args = await readFile(f.captureFile, "utf8");
    expect(args).toContain('CONFIG=url = "https://api.telegram.org/bot123:test-token/sendMessage"');
    expect(args).not.toContain("ARG=https://api.telegram.org");
    expect(args).toContain("ARG=chat_id=12345");
    expect(args).toContain("ARG=text=hello from tests");
    expect(args).toContain("ARG=--connect-timeout\nARG=5");
    expect(args).toContain("ARG=--max-time\nARG=20");
    expect(args).toContain("ARG=--retry\nARG=2");
    expect(result.stdout + result.stderr).not.toContain("test-token");
  });

  it("supports an explicit chat id override", async () => {
    const f = await fixture(
      "TELEGRAM_BOT_TOKEN='123:test-token'\nTELEGRAM_ALLOWED_USERS=12345\nRATATOSKR_CHAT_ID=-10099999\n"
    );
    const result = spawnSync(helper, ["send", "ping"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RATATOSKR_CHAT_ID: "",
        RATATOSKR_ENV_FILE: f.envFile,
        RATATOSKR_CURL_BIN: f.fakeCurl,
        CAPTURE_FILE: f.captureFile,
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(f.captureFile, "utf8")).toContain("ARG=chat_id=-10099999");
  });

  it("fails before curl when credentials or text are missing", async () => {
    const f = await fixture("TELEGRAM_ALLOWED_USERS=12345\n");
    const missingToken = spawnSync(helper, ["send", "ping"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RATATOSKR_CHAT_ID: "",
        RATATOSKR_ENV_FILE: f.envFile,
        RATATOSKR_CURL_BIN: f.fakeCurl,
        CAPTURE_FILE: f.captureFile,
      },
    });
    expect(missingToken.status).toBe(1);
    expect(missingToken.stderr).toContain("TELEGRAM_BOT_TOKEN is missing");
    await expect(readFile(f.captureFile, "utf8")).rejects.toThrow();

    const missingText = spawnSync(helper, ["send"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RATATOSKR_CHAT_ID: "",
        RATATOSKR_ENV_FILE: f.envFile,
        RATATOSKR_CURL_BIN: f.fakeCurl,
        CAPTURE_FILE: f.captureFile,
      },
    });
    expect(missingText.status).toBe(2);
    expect(missingText.stderr).toContain("Usage:");
  });

  it("propagates curl failures and prints Telegram's safe error body", async () => {
    const f = await fixture(
      "TELEGRAM_BOT_TOKEN=123:test-token\nTELEGRAM_ALLOWED_USERS=12345\n"
    );
    const result = spawnSync(helper, ["send", "too long"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RATATOSKR_CHAT_ID: "",
        RATATOSKR_ENV_FILE: f.envFile,
        RATATOSKR_CURL_BIN: f.fakeCurl,
        CAPTURE_FILE: f.captureFile,
        FAKE_CURL_EXIT: "22",
        FAKE_CURL_BODY: '{"description":"Bad Request"}',
      },
    });
    expect(result.status).toBe(22);
    expect(result.stderr).toContain("Bad Request");
    expect(result.stderr).not.toContain("test-token");
  });

  it("rejects unreadable env files, unknown commands, and oversized text without curl", async () => {
    const f = await fixture(
      "TELEGRAM_BOT_TOKEN=123:test-token\nTELEGRAM_ALLOWED_USERS=12345\n"
    );
    const baseEnv = {
      ...process.env,
      RATATOSKR_CHAT_ID: "",
      RATATOSKR_CURL_BIN: f.fakeCurl,
      CAPTURE_FILE: f.captureFile,
    };
    expect(
      spawnSync(helper, ["send", "x"], {
        encoding: "utf8",
        env: { ...baseEnv, RATATOSKR_ENV_FILE: path.join(path.dirname(f.envFile), "missing") },
      }).status
    ).toBe(1);
    expect(
      spawnSync(helper, ["bogus"], {
        encoding: "utf8",
        env: { ...baseEnv, RATATOSKR_ENV_FILE: f.envFile },
      }).status
    ).toBe(2);
    expect(
      spawnSync(helper, ["send", "x".repeat(4097)], {
        encoding: "utf8",
        env: { ...baseEnv, RATATOSKR_ENV_FILE: f.envFile },
      }).status
    ).toBe(1);
    expect(
      spawnSync(helper, ["send", "   "], {
        encoding: "utf8",
        env: { ...baseEnv, RATATOSKR_ENV_FILE: f.envFile },
      }).status
    ).toBe(2);
  });
});
