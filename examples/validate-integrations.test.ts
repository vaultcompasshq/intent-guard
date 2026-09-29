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

  // Claude Code only blocks a stop on exit 2. The mapping has to send EVERY
  // non-zero gate status there, not just 1: a gate that dies with 2 (usage or
  // fail-closed refusal) or 127 (command not found) must not let the turn end.
  it("blocks the stop when the gate exits 2", () => {
    const result = runStopHook({ line: "intent gate refused: bad ref", exitCode: 2 });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intent gate refused: bad ref");
  });

  it("blocks the stop when the gate exits 127", () => {
    const result = runStopHook({ line: "intent gate: command not found", exitCode: 127 });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intent gate: command not found");
  });
});

const SESSION_START = join(ROOT, "integrations/hooks/conductor-session-start.sh");

/**
 * A stub gate that echoes each argument on its own line, so a test can see the
 * exact --paths list the hook handed over.
 */
function argEchoStub(exitCode: number): string {
  return `#!/usr/bin/env bash\nfor a in "$@"; do printf 'ARG[%s]\\n' "$a"; done\nexit ${exitCode}\n`;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

interface HookWorld {
  work: string;
  bin: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

function makeWorld(options: { gitInit?: boolean; stub?: boolean } = {}): HookWorld {
  const work = mkdtempSync(join(tmpdir(), "intent-guard-hook-world-"));
  const bin = join(work, "bin");
  const project = join(work, "project");
  mkdirSync(bin);
  mkdirSync(project);
  if (options.gitInit !== false) {
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.email", "tester@example.com");
    git(project, "config", "user.name", "tester");
    git(project, "config", "commit.gpgsign", "false");
    writeFileSync(join(project, "README.md"), "# project\n", "utf8");
    git(project, "add", "--", "README.md");
    git(project, "commit", "-q", "-m", "initial");
  }
  let path = pathWithoutCheckBinary();
  if (options.stub !== false) {
    const stubPath = join(bin, "intent-guard-check");
    writeFileSync(stubPath, argEchoStub(0), "utf8");
    chmodSync(stubPath, 0o755);
    path = `${bin}${delimiter}${path}`;
  }
  return { work, bin, project, env: { ...process.env, PATH: path } };
}

function runHook(world: HookWorld, script: string) {
  const result = spawnSync("bash", [script], {
    cwd: world.project,
    encoding: "utf8",
    env: world.env,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The paths the stub gate was handed, or null when it got no --paths flag. */
function pathsSeen(stderr: string): string[] | null {
  const args = [...stderr.matchAll(/^ARG\[(.*)\]$/gm)].map((match) => match[1]);
  const at = args.indexOf("--paths");
  return at === -1 ? null : args[at + 1].split(",");
}

function write(world: HookWorld, relative: string, body = "x\n") {
  const file = join(world.project, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body, "utf8");
}

describe("stop hook changed-path collection", () => {
  it("judges an untracked new file", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      write(world, "secrets/new-key.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(pathsSeen(result.stderr)).toEqual(["secrets/new-key.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges work committed since the session began", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      write(world, "secrets/committed.txt");
      git(world.project, "add", "--", "secrets/committed.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      // The working tree is clean now: only the recorded start can see this.
      const result = runHook(world, STOP_CHECK);
      expect(pathsSeen(result.stderr)).toEqual(["secrets/committed.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not judge work committed before the session began", () => {
    const world = makeWorld();
    try {
      write(world, "earlier/old.txt");
      git(world.project, "add", "--", "earlier/old.txt");
      git(world.project, "commit", "-q", "-m", "before the session");
      runHook(world, SESSION_START);
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(pathsSeen(result.stderr)).toBeNull();
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("keeps the session baseline across a resume under the same contract", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      write(world, "secrets/kept.txt");
      git(world.project, "add", "--", "secrets/kept.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      runHook(world, SESSION_START); // resume fires SessionStart again
      const result = runHook(world, STOP_CHECK);
      expect(pathsSeen(result.stderr)).toEqual(["secrets/kept.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("starts a fresh baseline when the contract id changes", () => {
    const world = makeWorld();
    try {
      write(world, ".intent-guard/intent-contract.yaml", "contract_id: ic-aaa\n");
      git(world.project, "add", "--", ".intent-guard/intent-contract.yaml");
      git(world.project, "commit", "-q", "-m", "contract a");
      runHook(world, SESSION_START);
      write(world, "src/first-task.txt");
      git(world.project, "add", "--", "src/first-task.txt");
      git(world.project, "commit", "-q", "-m", "first task");
      write(world, ".intent-guard/intent-contract.yaml", "contract_id: ic-bbb\n");
      git(world.project, "add", "--", ".intent-guard/intent-contract.yaml");
      git(world.project, "commit", "-q", "-m", "contract b");
      runHook(world, SESSION_START);
      const result = runHook(world, STOP_CHECK);
      expect(pathsSeen(result.stderr)).toBeNull();
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("with no session-start record, says so and still judges uncommitted and untracked work", () => {
    const world = makeWorld();
    try {
      write(world, "secrets/new-key.txt");
      write(world, "README.md", "changed\n");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("no session-start record");
      expect([...(pathsSeen(result.stderr) ?? [])].sort()).toEqual([
        "README.md",
        "secrets/new-key.txt",
      ]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("passes a path with a double quote, a backslash, a tab and non-ASCII characters literally", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      const names = ['secrets/a"b.txt', "secrets/a\\b.txt", "secrets/a\tb.txt", "docs/café.md"];
      for (const name of names) write(world, name);
      const result = runHook(world, STOP_CHECK);
      expect([...(pathsSeen(result.stderr) ?? [])].map((p) => p.normalize("NFC")).sort()).toEqual(
        [...names].sort(),
      );
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("fails closed with a clear message when git cannot list the changes", () => {
    const world = makeWorld({ gitInit: false });
    try {
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("git failed while listing changed paths");
      expect(result.stderr).toContain("blocking the stop");
      // The gate must not have run on an empty list.
      expect(result.stderr).not.toContain("ARG[");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("refuses a path containing a comma instead of splitting it", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      write(world, "secrets/a,b.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("contains a comma");
      expect(result.stderr).not.toContain("ARG[");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

describe("hook binary resolution", () => {
  const PLANTED =
    "#!/usr/bin/env node\nconsole.error('PLANTED-DIST-RAN');\nprocess.exit(0);\n";

  function plant(world: HookWorld, packageName: string | null) {
    write(world, "packages/skill/dist/check-cli.js", PLANTED);
    if (packageName !== null) {
      write(world, "package.json", `{\n  "name": "${packageName}",\n  "private": true\n}\n`);
    }
  }

  it("does not run an in-repo dist in a repository that is not intent-guard's own", () => {
    const world = makeWorld();
    try {
      plant(world, "someone-elses-app");
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("PLANTED-DIST-RAN");
      // The installed binary on PATH (the arg-echo stub) judged instead.
      expect(result.stderr).toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not run an in-repo dist when there is no package.json at all", () => {
    const world = makeWorld();
    try {
      plant(world, null);
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("PLANTED-DIST-RAN");
      expect(result.stderr).toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("runs the in-repo dist in intent-guard's own repository", () => {
    const world = makeWorld();
    try {
      plant(world, "intent-guard");
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).toContain("PLANTED-DIST-RAN");
      expect(result.stderr).not.toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});
