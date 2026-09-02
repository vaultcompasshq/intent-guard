import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPreCommitHook } from "../src/hook.js";

/**
 * Runs the generated hook for real, against stub binaries, with a PATH that
 * contains nothing but those stubs. Anything the hook does not stub is
 * genuinely absent, which is what makes the missing-binary cases meaningful.
 */
function runHook(options: {
  withVaultGuard?: boolean;
  stubs: Record<string, number>;
}): { status: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-hook-exit-"));
  const binDir = join(dir, "bin");
  spawnSync("mkdir", ["-p", binDir]);

  for (const [name, code] of Object.entries(options.stubs)) {
    const stubPath = join(binDir, name);
    writeFileSync(
      stubPath,
      `#!/bin/sh\necho "${name} ran: $*"\nexit ${code}\n`,
      "utf8",
    );
    chmodSync(stubPath, 0o755);
  }

  const hookPath = join(dir, "pre-commit");
  writeFileSync(hookPath, renderPreCommitHook(options.withVaultGuard ?? false), "utf8");
  chmodSync(hookPath, 0o755);

  const result = spawnSync("/bin/bash", [hookPath], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: binDir },
  });

  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("generated pre-commit hook exit codes", () => {
  it("passes when every gate passes", () => {
    const run = runHook({
      withVaultGuard: true,
      stubs: { "intent-guard-check": 0, "vault-guard": 0 },
    });
    expect(run.status).toBe(0);
  });

  it("fails closed when the intent gate binary is missing", () => {
    // No intent-guard-check, no intent-guard, no npx anywhere on PATH.
    const run = runHook({ stubs: {} });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/not found on PATH/);
    // One line, and it must not read as a skip.
    expect(run.stderr).not.toMatch(/skipping/i);
  });

  it("fails closed when the secret scanner binary is missing", () => {
    const run = runHook({
      withVaultGuard: true,
      stubs: { "intent-guard-check": 0 },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/vault-guard/);
  });

  it("keeps the first non-zero exit code instead of the last", () => {
    // dep-guard-style exit 2 first, an ordinary policy failure after it. The
    // old hook assigned status twice and reported 1 here, losing the 2.
    const run = runHook({
      withVaultGuard: true,
      stubs: { "intent-guard-check": 2, "vault-guard": 1 },
    });
    expect(run.status).toBe(2);
  });

  it("still surfaces a later gate's failure when an earlier gate passed", () => {
    const run = runHook({
      withVaultGuard: true,
      stubs: { "intent-guard-check": 0, "vault-guard": 1 },
    });
    expect(run.status).toBe(1);
  });

  it("runs every gate even after one fails, and reports each code", () => {
    const run = runHook({
      withVaultGuard: true,
      stubs: { "intent-guard-check": 2, "vault-guard": 1 },
    });
    expect(run.stdout).toMatch(/intent-guard-check ran/);
    expect(run.stdout).toMatch(/vault-guard ran/);
    // No code is lost to the single-integer exit status: both are printed.
    expect(run.stderr).toMatch(/exited 2/);
    expect(run.stderr).toMatch(/exited 1/);
  });
});
