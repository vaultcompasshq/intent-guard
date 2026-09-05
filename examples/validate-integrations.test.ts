import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function readText(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("integration hook samples", () => {
  it("ships valid Codex hooks JSON", () => {
    const hooks = readJson("integrations/codex/hooks.json.sample");
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      "conductor-session-start.sh",
    );
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain(
      "conductor-stop-check.sh",
    );
  });

  it("ships valid Claude Code settings JSON", () => {
    const settings = readJson("integrations/claude-code/settings.sample.json");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "${CLAUDE_PROJECT_DIR}",
    );
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(60);
  });

  it("keeps hook shell scripts syntactically valid", () => {
    for (const script of [
      "integrations/git-hooks/pre-commit.sample",
      "integrations/git-hooks/pre-commit-with-vault-guard.sample",
      "integrations/hooks/conductor-lib.sh",
      "integrations/hooks/conductor-session-start.sh",
      "integrations/hooks/conductor-stop-check.sh",
    ]) {
      expect(() =>
        execFileSync("bash", ["-n", join(ROOT, script)], {
          encoding: "utf8",
        }),
      ).not.toThrow();
    }
  });

  it("ships a GitHub Actions gate CI sample", () => {
    const workflow = readText(
      "integrations/github-actions/conductor-drift-ci.yml.sample",
    );
    expect(workflow).toContain("@vaultcompass/intent-guard@latest");
    // CI must run the full gate (`check`), which enforces the change budget,
    // not the score-only `drift` command.
    expect(workflow).toContain("check");
    expect(workflow).toContain("--paths");

    const pairedWorkflow = readText(
      "integrations/github-actions/conductor-vault-guard-ci.yml.sample",
    );
    expect(pairedWorkflow).toContain("@vaultcompass/intent-guard@latest");
    expect(pairedWorkflow).toContain("@vaultcompass/vault-guard@latest");
    expect(pairedWorkflow).toContain("scan . --format text");
  });
});

const STOP_CHECK = join(ROOT, "integrations/hooks/conductor-stop-check.sh");

// PATH entries that already carry a real intent-guard-check (a global install,
// or node_modules/.bin when the suite runs under pnpm). The missing-binary case
// has to run without any of them for the fail-closed path to be reachable.
function pathWithoutCheckBinary(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, "intent-guard-check")))
    .join(delimiter);
}

function stubScript(line: string, exitCode: number): string {
  if (line.includes("'")) {
    throw new Error("stub output must not contain a single quote");
  }
  return `#!/usr/bin/env bash\nprintf '%s\\n' '${line}'\nexit ${exitCode}\n`;
}

function runStopHook(stub?: { line: string; exitCode: number }) {
  const work = mkdtempSync(join(tmpdir(), "intent-guard-stop-hook-"));
  try {
    const bin = join(work, "bin");
    const project = join(work, "project");
    mkdirSync(bin);
    mkdirSync(project);
    spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" });

    let path = pathWithoutCheckBinary();
    if (stub) {
      const stubPath = join(bin, "intent-guard-check");
      writeFileSync(stubPath, stubScript(stub.line, stub.exitCode), "utf8");
      chmodSync(stubPath, 0o755);
      path = `${bin}${delimiter}${path}`;
    }

    const result = spawnSync("bash", [STOP_CHECK], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });

    return {
      code: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Codex reads a Stop hook's exit-2 reason from stderr and rejects plain text on
// stdout at exit 0, so the adapter has to keep stdout empty on every path.
describe("stop hook stream contract", () => {
  it("keeps a passing check off stdout and on stderr", () => {
    const result = runStopHook({ line: "intent gate ok: 2 paths in scope", exitCode: 0 });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intent gate ok: 2 paths in scope");
  });

  it("reports a blocked check on stderr and exits 2", () => {
    const result = runStopHook({
      line: "intent gate blocked: src/app.ts is out of scope",
      exitCode: 1,
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intent gate blocked: src/app.ts is out of scope");
  });

  it("fails closed on stderr when no check binary resolves", () => {
    const result = runStopHook();
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intent-guard-check not found");
  });
});
