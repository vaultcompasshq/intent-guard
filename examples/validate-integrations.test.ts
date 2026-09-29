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

function makeWorld(
  options: { gitInit?: boolean; stub?: boolean; gateExit?: number } = {},
): HookWorld {
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
    writeFileSync(stubPath, argEchoStub(options.gateExit ?? 0), "utf8");
    chmodSync(stubPath, 0o755);
    path = `${bin}${delimiter}${path}`;
  }
  return { work, bin, project, env: { ...process.env, PATH: path } };
}

function runHook(
  world: HookWorld,
  script: string,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync("bash", [script], {
    cwd: world.project,
    encoding: "utf8",
    env: { ...world.env, ...options.env },
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** SessionStart the way a host sends it: a JSON object with a `source`. */
function startSession(world: HookWorld, source: string | null) {
  return runHook(world, SESSION_START, {
    input: source === null ? "" : JSON.stringify({ hook_event_name: "SessionStart", source }),
  });
}

/** The raw paths the stub gate was handed, or null when it got no --paths flag. */
function rawPathsSeen(stderr: string): string[] | null {
  const args = [...stderr.matchAll(/^ARG\[(.*)\]$/gm)].map((match) => match[1]);
  const at = args.indexOf("--paths");
  return at === -1 ? null : args[at + 1].split(",");
}

/** Same, with the leading "./" the hook adds removed. */
function pathsSeen(stderr: string): string[] | null {
  const raw = rawPathsSeen(stderr);
  return raw === null ? null : raw.map((path) => path.replace(/^\.\//, ""));
}

const REAL_GATE_ASK =
  "Update the readme usage docs. Do not change source. Done when one usage example is documented.";

/**
 * A world whose `intent-guard-check` is the real built gate, with a frozen
 * contract protecting secrets/**, committed. For tests where what the budget
 * DECIDES matters and a stub that echoes arguments is not enough.
 */
function makeRealGateWorld(): HookWorld {
  const world = makeWorld({ stub: false });
  const checkCli = join(ROOT, "packages/skill/dist/check-cli.js");
  const wrapper = join(world.bin, "intent-guard-check");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${checkCli}" "$@"\n`, "utf8");
  chmodSync(wrapper, 0o755);
  world.env = { ...world.env, PATH: `${world.bin}${delimiter}${world.env.PATH}` };
  const dist = (cli: string) => join(ROOT, "packages/skill/dist", cli);
  execFileSync("node", [dist("extract-cli.js"), "--project", world.project, "--text", REAL_GATE_ASK]);
  execFileSync("node", [dist("freeze-cli.js"), "--project", world.project, "--approved-by", "tester"]);
  const contract = join(world.project, ".intent-guard", "intent-contract.yaml");
  writeFileSync(
    contract,
    readFileSync(contract, "utf8") + '\nbudget:\n  protected_paths:\n    - "secrets/**"\n',
    "utf8",
  );
  git(world.project, "add", "--", ".intent-guard");
  git(world.project, "commit", "-q", "-m", "freeze contract");
  return world;
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

  for (const source of ["resume", "compact", null]) {
    it(`keeps the session baseline when SessionStart fires again with source ${source ?? "absent"}`, () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        write(world, "secrets/kept.txt");
        git(world.project, "add", "--", "secrets/kept.txt");
        git(world.project, "commit", "-q", "-m", "agent commit");
        startSession(world, source);
        const result = runHook(world, STOP_CHECK);
        expect(pathsSeen(result.stderr)).toEqual(["secrets/kept.txt"]);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  }

  // Session A stops clean, the human commits, session B starts. The human's
  // commit is not session B's work and must not be judged against its contract.
  for (const source of ["startup", "clear"]) {
    it(`starts a fresh baseline on a new session (source ${source}), so a human commit between sessions is not judged`, () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        expect(runHook(world, STOP_CHECK).code).toBe(0);
        write(world, "secrets/human.txt");
        git(world.project, "add", "--", "secrets/human.txt");
        git(world.project, "commit", "-q", "-m", "the human commits");
        startSession(world, source);
        write(world, "README.md", "session B edit\n");
        const result = runHook(world, STOP_CHECK);
        expect(result.code).toBe(0);
        expect(pathsSeen(result.stderr)).toEqual(["README.md"]);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  }

  it("adds a leading ./ to every path so a name starting with a dash is not read as a flag", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "--evil.txt");
      write(world, "-rf");
      const result = runHook(world, STOP_CHECK);
      expect([...(rawPathsSeen(result.stderr) ?? [])].sort()).toEqual(["./--evil.txt", "./-rf"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not block the stop on a dash-prefixed name with the real gate", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "--evil.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("Usage:");
      expect(result.code).toBe(0);
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

  it("fails closed with no session-start record and no upstream", () => {
    const world = makeWorld();
    try {
      write(world, "secrets/new-key.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no session-start record and no upstream");
      expect(result.stderr).toContain("INTENT_GUARD_NO_BASELINE_OK=1");
      expect(result.stderr).not.toContain("ARG[");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("INTENT_GUARD_NO_BASELINE_OK=1 falls back to HEAD with a warning", () => {
    const world = makeWorld();
    try {
      write(world, "secrets/new-key.txt");
      write(world, "README.md", "changed\n");
      const result = runHook(world, STOP_CHECK, { env: { INTENT_GUARD_NO_BASELINE_OK: "1" } });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("cannot be seen");
      expect([...(pathsSeen(result.stderr) ?? [])].sort()).toEqual([
        "README.md",
        "secrets/new-key.txt",
      ]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("with no record but an upstream branch, judges changes since the upstream", () => {
    const world = makeWorld();
    try {
      git(world.project, "branch", "upstream-stand-in");
      git(world.project, "branch", "--set-upstream-to=upstream-stand-in", "main");
      write(world, "secrets/ahead.txt");
      git(world.project, "add", "--", "secrets/ahead.txt");
      git(world.project, "commit", "-q", "-m", "unpushed");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("since the upstream branch");
      expect(pathsSeen(result.stderr)).toEqual(["secrets/ahead.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  describe("baseline record integrity", () => {
    function baselineFile(world: HookWorld): string {
      return join(world.project, ".git", "intent-guard-session-start");
    }
    function head(world: HookWorld, rev: string): string {
      return execFileSync("git", ["rev-parse", rev], {
        cwd: world.project,
        encoding: "utf8",
      }).trim();
    }
    function expectRefused(world: HookWorld) {
      write(world, "secrets/new-key.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("session baseline record");
      expect(result.stderr).not.toContain("ARG[");
    }

    it("refuses a record that points at a tree, such as HEAD^{tree}", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(baselineFile(world), `${head(world, "HEAD^{tree}")}\nnone\n`, "utf8");
        expectRefused(world);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("refuses a record that is a name rather than an object id, such as HEAD", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(baselineFile(world), "HEAD\nnone\n", "utf8");
        expectRefused(world);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("refuses a record for a commit that is not an ancestor of HEAD", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        const orphan = execFileSync(
          "git",
          ["commit-tree", head(world, "HEAD^{tree}"), "-m", "elsewhere"],
          { cwd: world.project, encoding: "utf8" },
        ).trim();
        writeFileSync(baselineFile(world), `${orphan}\nnone\n`, "utf8");
        expectRefused(world);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("refuses a garbage record", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(baselineFile(world), "not a ref at all\n", "utf8");
        expectRefused(world);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("accepts the empty tree, the widest baseline", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
          cwd: world.project,
          encoding: "utf8",
        }).trim();
        writeFileSync(baselineFile(world), `${emptyTree}\nnone\n`, "utf8");
        const result = runHook(world, STOP_CHECK);
        expect(result.code).toBe(0);
        expect(pathsSeen(result.stderr)).toEqual(["README.md"]);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
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

  it("does not run a planted in-repo dist by default", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      plant(world, "someone-elses-app");
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("PLANTED-DIST-RAN");
      // The installed binary on PATH (the arg-echo stub) judged instead.
      expect(result.stderr).toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not run a planted dist when package.json is renamed to intent-guard", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      plant(world, "intent-guard");
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("PLANTED-DIST-RAN");
      expect(result.stderr).toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not run a planted dist when there is no package.json at all", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      plant(world, null);
      const result = runHook(world, STOP_CHECK);
      expect(result.stderr).not.toContain("PLANTED-DIST-RAN");
      expect(result.stderr).toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("runs the in-repo dist only when the operator sets INTENT_GUARD_DEV_DIST=1", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      plant(world, null);
      const result = runHook(world, STOP_CHECK, { env: { INTENT_GUARD_DEV_DIST: "1" } });
      expect(result.stderr).toContain("PLANTED-DIST-RAN");
      expect(result.stderr).not.toContain("ARG[--project]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

// Loop policy. A finding blocks every time. A could-not-run condition blocks the
// first time and, once the host says the stop is already a continuation
// (stop_hook_active), lets it through with a loud message, because the agent
// cannot fix it and blocking again only loops.
describe("stop hook loop policy", () => {
  const ACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true });
  const INACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });

  interface Scenario {
    label: string;
    setup: () => HookWorld;
  }

  const scenarios: Scenario[] = [
    {
      label: "no baseline and no upstream",
      setup: () => makeWorld(),
    },
    {
      label: "an invalid baseline record",
      setup: () => {
        const world = makeWorld();
        startSession(world, "startup");
        writeFileSync(join(world.project, ".git", "intent-guard-session-start"), "HEAD\nnone\n");
        return world;
      },
    },
    {
      label: "a git failure during collection",
      setup: () => makeWorld({ gitInit: false }),
    },
    {
      label: "a comma in a path",
      setup: () => {
        const world = makeWorld();
        startSession(world, "startup");
        write(world, "docs/a,b.txt");
        return world;
      },
    },
    {
      label: "a backslash in a path (the gate refuses it with exit 2)",
      setup: () => {
        const world = makeRealGateWorld();
        startSession(world, "startup");
        write(world, "docs/a\\b.txt");
        return world;
      },
    },
    {
      label: "the gate exiting 2",
      setup: () => {
        const world = makeWorld({ gateExit: 2 });
        startSession(world, "startup");
        return world;
      },
    },
    {
      label: "the gate exiting 127",
      setup: () => {
        const world = makeWorld({ gateExit: 127 });
        startSession(world, "startup");
        return world;
      },
    },
    {
      label: "no gate binary",
      setup: () => makeWorld({ stub: false }),
    },
  ];

  for (const scenario of scenarios) {
    it(`blocks on ${scenario.label} when stop_hook_active is false`, () => {
      const world = scenario.setup();
      try {
        const result = runHook(world, STOP_CHECK, { input: INACTIVE });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it(`blocks on ${scenario.label} when the field is absent or unparseable`, () => {
      const world = scenario.setup();
      try {
        for (const input of ["", "{}", "not json at all"]) {
          expect(runHook(world, STOP_CHECK, { input }).code).toBe(2);
        }
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it(`allows the stop with a loud message on ${scenario.label} when stop_hook_active is true`, () => {
      const world = scenario.setup();
      try {
        const result = runHook(world, STOP_CHECK, { input: ACTIVE });
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("COULD NOT RUN");
        expect(result.stderr).toContain("NOT judged");
        expect(result.stderr).toContain("CI running intent-guard check --base");
        const shown = JSON.parse(result.stdout);
        expect(shown.systemMessage).toContain("COULD NOT RUN");
        expect(shown.systemMessage).toContain("intent-guard check --base");
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  }

  it("still blocks a finding when stop_hook_active is true (stub gate exits 1)", () => {
    const world = makeWorld({ gateExit: 1 });
    try {
      startSession(world, "startup");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("still blocks a real budget hard_block when stop_hook_active is true", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/new-key.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("passes a clean run with stop_hook_active true and prints nothing on stdout", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

// The budget's glob regexp had no `s` flag, so a newline in a name kept ** from
// matching. Through the hook the name travels NUL-separated and then inside
// --paths, so this is the end-to-end check with the real gate.
describe("stop hook and a newline in a file name", () => {
  const NAME = "secrets/a\nb.txt";

  it("blocks an untracked new file with a newline in its name under secrets/", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, NAME);
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks a staged rename of such a file out of secrets/", () => {
    const world = makeRealGateWorld();
    try {
      write(world, NAME);
      git(world.project, "add", "--", NAME);
      git(world.project, "commit", "-q", "-m", "add before the session");
      startSession(world, "startup");
      git(world.project, "mv", NAME, "docs-moved.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks a committed rename of such a file out of secrets/", () => {
    const world = makeRealGateWorld();
    try {
      write(world, NAME);
      git(world.project, "add", "--", NAME);
      git(world.project, "commit", "-q", "-m", "add before the session");
      startSession(world, "startup");
      git(world.project, "mv", NAME, "docs-moved.txt");
      git(world.project, "commit", "-q", "-m", "move it out");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});
