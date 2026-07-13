import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/deploy-pi.sh");

async function fakeFleet() {
  const dir = await mkdtemp(path.join(tmpdir(), "ratatoskr-deploy-"));
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  const marker = path.join(dir, "marker");
  const sha = "a".repeat(40);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const tools: Record<string, string> = {
    git: `#!/usr/bin/env bash
if [[ -n "\${FAKE_GIT_EMPTY:-}" ]]; then exit 1; fi
if [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%s\\n' "$FAKE_SHA"; fi
if [[ "$*" == *"status --porcelain"* && -n "\${FAKE_DIRTY:-}" ]]; then printf ' M src/index.ts\\n'; fi
`,
    npm: `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$FAKE_LOG"
`,
    rsync: `#!/usr/bin/env bash
printf 'rsync %s\\n' "$*" >> "$FAKE_LOG"
`,
    ssh: `#!/usr/bin/env bash
command="\${2:-}"
printf 'ssh %s\\n' "$command" >> "$FAKE_LOG"
if [[ "$command" == *"cat >"*".deployed-commit"* ]]; then
  cat > "$FAKE_MARKER"
fi
`,
    sudo: `#!/usr/bin/env bash
printf 'sudo %s\\n' "$*" >> "$FAKE_LOG"
if [[ -n "\${FAKE_SUDO_FAIL_STATUS:-}" && "$*" == *"systemctl status"* ]]; then exit 1; fi
`,
    sleep: `#!/usr/bin/env bash
exit 0
`,
  };
  for (const [name, body] of Object.entries(tools)) {
    const target = path.join(bin, name);
    await writeFile(target, body);
    await chmod(target, 0o755);
  }
  return { dir, bin, log, marker, sha };
}

async function fakeSourceWorktree(root: string) {
  const project = path.join(root, "source-worktree");
  const scripts = path.join(project, "scripts");
  const worktreeScript = path.join(scripts, "deploy-pi.sh");
  const gitPointer = "gitdir: /private/tmp/deleted-workstation-gitdir\n";
  await mkdir(scripts, { recursive: true });
  await copyFile(script, worktreeScript);
  await chmod(worktreeScript, 0o755);
  await writeFile(path.join(project, ".git"), gitPointer);
  return { project, script: worktreeScript, gitPointer };
}

describe("deploy-pi.sh provenance marker", () => {
  it("excludes worktree git files and removes remote artifact metadata before sync", async () => {
    const f = await fakeFleet();
    const source = await fakeSourceWorktree(f.dir);
    const result = spawnSync(source.script, ["fake-host"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        DEPLOY_COMMIT: f.sha,
        FAKE_SHA: f.sha,
        FAKE_LOG: f.log,
        FAKE_MARKER: f.marker,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(source.project, ".git"), "utf8")).toBe(
      source.gitPointer
    );
    const calls = await readFile(f.log, "utf8");
    const cleanup = calls.indexOf(
      "rm -rf '/home/magnus/repos/ratatoskr/.git'"
    );
    const sync = calls.indexOf("rsync ");
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(sync).toBeGreaterThan(cleanup);
    const rsyncCall = calls
      .split("\n")
      .find((line) => line.startsWith("rsync "));
    expect(rsyncCall).toContain("--exclude=.git");
    expect(rsyncCall).toContain(`${source.project}/`);
    expect(calls).toContain(
      "ssh cd /home/magnus/repos/ratatoskr && npm ci --omit=dev"
    );
  });

  it("writes the exact clean SHA only after a successful restart", async () => {
    const f = await fakeFleet();
    const result = spawnSync(script, ["fake-host"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        DEPLOY_COMMIT: f.sha,
        FAKE_SHA: f.sha,
        FAKE_LOG: f.log,
        FAKE_MARKER: f.marker,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.marker, "utf8")).toBe(`${f.sha}\n`);
    const calls = await readFile(f.log, "utf8");
    const remove = calls.indexOf("rm -f");
    const sync = calls.indexOf("rsync ");
    const restart = calls.indexOf("systemctl restart ratatoskr");
    const marker = calls.indexOf("cat > '/home/magnus/repos/ratatoskr/.deployed-commit'");
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(sync).toBeGreaterThan(remove);
    expect(restart).toBeGreaterThan(sync);
    expect(marker).toBeGreaterThan(restart);
  });

  it("rejects non-SHA input before any remote command can run", async () => {
    const f = await fakeFleet();
    const result = spawnSync(script, ["local"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        DEPLOY_COMMIT: "x'; echo PWNED; '",
        FAKE_GIT_EMPTY: "1",
        FAKE_SHA: f.sha,
        FAKE_LOG: f.log,
        FAKE_MARKER: f.marker,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("PWNED\n");
  });

  it("rejects dirty and mismatched remote source checkouts", async () => {
    const dirty = await fakeFleet();
    const common = {
      ...process.env,
      PATH: `${dirty.bin}:${process.env.PATH}`,
      FAKE_SHA: dirty.sha,
      FAKE_LOG: dirty.log,
      FAKE_MARKER: dirty.marker,
    };
    const dirtyResult = spawnSync(script, ["fake-host"], {
      encoding: "utf8",
      env: { ...common, FAKE_DIRTY: "1" },
    });
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain("dirty working tree");

    const mismatchResult = spawnSync(script, ["fake-host"], {
      encoding: "utf8",
      env: { ...common, DEPLOY_COMMIT: "b".repeat(40) },
    });
    expect(mismatchResult.status).toBe(1);
    expect(mismatchResult.stderr).toContain("does not match");
  });

  it("rejects remote deploys without git and local deploys without an explicit SHA", async () => {
    const f = await fakeFleet();
    const common = {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      FAKE_SHA: f.sha,
      FAKE_LOG: f.log,
      FAKE_MARKER: f.marker,
    };
    const noGit = spawnSync(script, ["fake-host"], {
      encoding: "utf8",
      env: { ...common, FAKE_GIT_EMPTY: "1" },
    });
    expect(noGit.status).toBe(1);
    expect(noGit.stderr).toContain("requires a Git source checkout");

    const noLocalSha = spawnSync(script, ["local"], {
      encoding: "utf8",
      env: { ...common, DEPLOY_COMMIT: "" },
    });
    expect(noLocalSha.status).toBe(1);
    expect(noLocalSha.stderr).toContain("local deploy requires DEPLOY_COMMIT");
  });

  it("requires explicit provenance locally and writes it only after restart success", async () => {
    const f = await fakeFleet();
    const markerPath = path.resolve(".deployed-commit");
    await import("node:fs/promises").then(({ rm }) => rm(markerPath, { force: true }));
    const env = {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      DEPLOY_COMMIT: f.sha,
      FAKE_SHA: "b".repeat(40), // stale Pi git must be ignored
      FAKE_LOG: f.log,
      FAKE_MARKER: f.marker,
    };
    const failed = spawnSync(script, ["local"], {
      encoding: "utf8",
      env: { ...env, FAKE_SUDO_FAIL_STATUS: "1" },
    });
    expect(failed.status).toBe(1);
    await expect(readFile(markerPath, "utf8")).rejects.toThrow();

    const passed = spawnSync(script, ["local"], { encoding: "utf8", env });
    expect(passed.status, passed.stderr).toBe(0);
    expect(await readFile(markerPath, "utf8")).toBe(`${f.sha}\n`);
    await import("node:fs/promises").then(({ rm }) => rm(markerPath, { force: true }));
  });

  it("keeps the marker ignored by git", () => {
    const ignored = execFileSync("git", ["check-ignore", ".deployed-commit"], {
      encoding: "utf8",
    });
    expect(ignored.trim()).toBe(".deployed-commit");
  });
});
