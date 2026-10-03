import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
 * exact --paths list the hook handed over. It also lists what --base and
 * --staged name, with the same git calls the real gate makes, so a test can
 * see the whole set of paths the gate was given to judge.
 */
function argEchoStub(exitCode: number): string {
  return [
    "#!/usr/bin/env bash",
    `for a in "$@"; do printf 'ARG[%s]\\n' "$a"; done`,
    'project=""; prev=""',
    'for a in "$@"; do [[ "$prev" == "--project" ]] && project="$a"; prev="$a"; done',
    'prev=""',
    'for a in "$@"; do',
    '  if [[ "$prev" == "--base" ]]; then',
    `    git -C "$project" -c core.quotePath=false diff --no-renames --ignore-submodules=none --name-only -z "$a...HEAD" -- | while IFS= read -r -d '' p; do printf 'CHANNEL[%s]\\n' "$p"; done`,
    "  fi",
    '  if [[ "$a" == "--staged" ]]; then',
    `    git -C "$project" -c core.quotePath=false diff --cached --no-renames --ignore-submodules=none --name-only -z -- | while IFS= read -r -d '' p; do printf 'CHANNEL[%s]\\n' "$p"; done`,
    "  fi",
    '  prev="$a"',
    "done",
    `exit ${exitCode}`,
    "",
  ].join("\n");
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

/**
 * The raw paths the stub gate was handed on the command line, across every
 * --paths argument, or null when it got no --paths flag.
 */
function rawPathsSeen(stderr: string): string[] | null {
  const args = [...stderr.matchAll(/^ARG\[(.*)\]$/gm)].map((match) => match[1]);
  const values = args.flatMap((arg, i) => (arg === "--paths" ? [args[i + 1]] : []));
  return values.length === 0 ? null : values.flatMap((value) => value.split(","));
}

/**
 * Every path the stub gate was given to judge, through --paths (with the
 * leading "./" the hook adds removed), --base or --staged, each once, or null
 * when it was given none.
 */
function pathsSeen(stderr: string): string[] | null {
  const fromPaths = (rawPathsSeen(stderr) ?? []).map((path) => path.replace(/^\.\//, ""));
  const fromChannels = [...stderr.matchAll(/^CHANNEL\[(.*)\]$/gm)].map((match) => match[1]);
  const all = [...new Set([...fromPaths, ...fromChannels])];
  return all.length === 0 ? null : all;
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

  it("keeps the session baseline when the contract id changes", () => {
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
      // A new session (startup or clear) is what records a fresh baseline; a
      // contract change inside the session is judged from where it began.
      expect([...(pathsSeen(result.stderr) ?? [])].sort()).toEqual([
        ".intent-guard/intent-contract.yaml",
        "src/first-task.txt",
      ]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks with no session-start record and no upstream, and still judges the uncommitted work", () => {
    const world = makeWorld();
    try {
      write(world, "secrets/new-key.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no session-start record and no upstream");
      expect(result.stderr).toContain("INTENT_GUARD_NO_BASELINE_OK=1");
      // What can still be judged is: the untracked file reached the gate.
      expect(pathsSeen(result.stderr)).toEqual(["secrets/new-key.txt"]);
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
      // Refused as a baseline; the uncommitted file is still judged.
      expect(pathsSeen(result.stderr)).toEqual(["secrets/new-key.txt"]);
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

  describe("baseline record across SessionStart sources", () => {
    const RECORD = (world: HookWorld) => join(world.project, ".git", "intent-guard-session-start");

    for (const source of ["resume", "compact", null]) {
      it(`leaves an invalid record untouched on SessionStart with source ${source ?? "absent"}`, () => {
        const world = makeWorld();
        try {
          startSession(world, "startup");
          write(world, "secrets/k.txt");
          git(world.project, "add", "--", "secrets/k.txt");
          git(world.project, "commit", "-q", "-m", "agent commit");
          writeFileSync(RECORD(world), "garbage\nnone\n", "utf8");
          startSession(world, source);
          expect(readFileSync(RECORD(world), "utf8")).toBe("garbage\nnone\n");
          const result = runHook(world, STOP_CHECK);
          expect(result.code).toBe(2);
          expect(result.stderr).toContain("session baseline record");
        } finally {
          rmSync(world.work, { recursive: true, force: true });
        }
      });

      it(`keeps the old baseline when the contract id changes before SessionStart with source ${source ?? "absent"}`, () => {
        const world = makeWorld();
        try {
          write(world, ".intent-guard/intent-contract.yaml", "contract_id: ic-aaa\n");
          git(world.project, "add", "--", ".intent-guard/intent-contract.yaml");
          git(world.project, "commit", "-q", "-m", "contract a");
          startSession(world, "startup");
          write(world, "secrets/k.txt");
          git(world.project, "add", "--", "secrets/k.txt");
          git(world.project, "commit", "-q", "-m", "agent commit");
          write(world, ".intent-guard/intent-contract.yaml", "contract_id: ic-bbb\n");
          startSession(world, source);
          write(world, ".intent-guard/intent-contract.yaml", "contract_id: ic-aaa\n");
          const result = runHook(world, STOP_CHECK);
          expect(pathsSeen(result.stderr)).toEqual(["secrets/k.txt"]);
        } finally {
          rmSync(world.work, { recursive: true, force: true });
        }
      });

      it(`writes a record when none exists, on SessionStart with source ${source ?? "absent"}`, () => {
        const world = makeWorld();
        try {
          startSession(world, source);
          expect(existsSync(RECORD(world))).toBe(true);
          expect(runHook(world, STOP_CHECK).code).toBe(0);
        } finally {
          rmSync(world.work, { recursive: true, force: true });
        }
      });
    }

    it("says to start a new session, not to run /clear, about an invalid record", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(RECORD(world), "garbage\nnone\n", "utf8");
        const start = startSession(world, "resume");
        const stop = runHook(world, STOP_CHECK);
        for (const text of [start.stderr, stop.stderr]) {
          expect(text).toContain("start a new session");
          expect(text).not.toContain("/clear");
        }
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  });

  describe("judging what can be judged without a usable baseline", () => {
    const ACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true });

    it("blocks a finding in untracked work every time when the record is invalid (real gate)", () => {
      const world = makeRealGateWorld();
      try {
        startSession(world, "startup");
        writeFileSync(join(world.project, ".git", "intent-guard-session-start"), "garbage\nnone\n");
        write(world, "secrets/new-key.txt");
        const result = runHook(world, STOP_CHECK, { input: ACTIVE });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("Budget hard_block");
        expect(result.stdout).toBe("");
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("blocks a finding in staged work every time with no record and no upstream (real gate)", () => {
      const world = makeRealGateWorld();
      try {
        write(world, "secrets/new-key.txt");
        git(world.project, "add", "--", "secrets/new-key.txt");
        const result = runHook(world, STOP_CHECK, { input: ACTIVE });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("Budget hard_block");
        expect(result.stdout).toBe("");
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("judges the index, the work tree and untracked files against HEAD when the record is invalid", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(join(world.project, ".git", "intent-guard-session-start"), "garbage\nnone\n");
        write(world, "src/staged.txt");
        git(world.project, "add", "--", "src/staged.txt");
        write(world, "README.md", "edited\n");
        write(world, "src/untracked.txt");
        const result = runHook(world, STOP_CHECK);
        expect([...(pathsSeen(result.stderr) ?? [])].sort()).toEqual([
          "README.md",
          "src/staged.txt",
          "src/untracked.txt",
        ]);
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });

    it("reports the committed part as not judged once the rest passes, and lets the second stop through", () => {
      const world = makeWorld();
      try {
        startSession(world, "startup");
        writeFileSync(join(world.project, ".git", "intent-guard-session-start"), "garbage\nnone\n");
        expect(runHook(world, STOP_CHECK, { input: "" }).code).toBe(2);
        const result = runHook(world, STOP_CHECK, { input: ACTIVE });
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("COULD NOT RUN");
        expect(JSON.parse(result.stdout).systemMessage).toContain("committed");
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  });

  it("passes a path with a double quote, a tab and non-ASCII characters literally, and blocks on a backslash", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      const names = ['secrets/a"b.txt', "secrets/a\tb.txt", "docs/café.md"];
      for (const name of names) write(world, name);
      write(world, "secrets/a\\b.txt");
      const result = runHook(world, STOP_CHECK);
      expect([...(pathsSeen(result.stderr) ?? [])].map((p) => p.normalize("NFC")).sort()).toEqual(
        [...names].sort(),
      );
      // The gate refuses a backslash in --paths, so the hook never sends one;
      // it blocks and names the path instead.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("contains a backslash");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("passes a staged backslash path to the gate through --staged", () => {
    const world = makeWorld();
    try {
      runHook(world, SESSION_START);
      write(world, "secrets/a\\b.txt");
      git(world.project, "add", "--", "secrets/a\\b.txt");
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(pathsSeen(result.stderr)).toEqual(["secrets/a\\b.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges a file named exactly like the session baseline commit id", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      const baseline = readFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        "utf8",
      ).split("\n")[0];
      write(world, baseline);
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("git failed");
      expect(result.stderr).toContain(`ARG[`);
      expect(JSON.stringify(result.stderr)).toContain(baseline);
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

  it("sends committed and staged work through --base and --staged, not --paths", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "src/committed.txt");
      git(world.project, "add", "--", "src/committed.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      write(world, "src/staged.txt");
      git(world.project, "add", "--", "src/staged.txt");
      write(world, "src/untracked.txt");
      const baseline = readFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        "utf8",
      ).split("\n")[0];
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      const args = [...result.stderr.matchAll(/^ARG\[(.*)\]$/gm)].map((match) => match[1]);
      expect(args[args.indexOf("--base") + 1]).toBe(baseline);
      expect(args).toContain("--staged");
      expect(rawPathsSeen(result.stderr)).toEqual(["./src/untracked.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not repeat in --paths a path the other two channels already carry", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "src/committed.txt");
      git(world.project, "add", "--", "src/committed.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      write(world, "src/committed.txt", "edited again\n");
      write(world, "src/staged.txt");
      git(world.project, "add", "--", "src/staged.txt");
      write(world, "src/staged.txt", "edited after staging\n");
      write(world, "src/only-in-tree.txt");
      const result = runHook(world, STOP_CHECK);
      expect(rawPathsSeen(result.stderr)).toEqual(["./src/only-in-tree.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("splits a long --paths list into repeated arguments, each under 128 KiB", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      const long = "d".repeat(180);
      for (let i = 0; i < 700; i++) write(world, `docs/${long}-${String(i).padStart(4, "0")}.md`);
      const result = runHook(world, STOP_CHECK);
      expect(result.code).toBe(0);
      const args = [...result.stderr.matchAll(/^ARG\[(.*)\]$/gm)].map((match) => match[1]);
      const values = args.flatMap((arg, i) => (arg === "--paths" ? [args[i + 1]] : []));
      expect(values.length).toBeGreaterThan(1);
      for (const value of values) expect(Buffer.byteLength(value)).toBeLessThan(128 * 1024);
      expect(values.flatMap((value) => value.split(","))).toHaveLength(700);
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
      // The rest of the change is still judged; the comma path is not split
      // into two names on the way.
      expect(result.stderr).toContain("ARG[");
      expect(rawPathsSeen(result.stderr)).toBeNull();
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

  // A path the hook cannot put on the command line is something the agent can
  // clear ("git add" it, rename it, or ignore it), so it is a finding: it
  // blocks every time, and the rest of the change is still judged.
  const unpassable: Scenario[] = [
    {
      label: "a comma in an untracked path",
      setup: () => {
        const world = makeWorld();
        startSession(world, "startup");
        write(world, "docs/a,b.txt");
        return world;
      },
    },
    {
      label: "a backslash in an untracked path, with the real gate",
      setup: () => {
        const world = makeRealGateWorld();
        startSession(world, "startup");
        write(world, "docs/a\\b.txt");
        return world;
      },
    },
  ];

  for (const scenario of unpassable) {
    it(`still blocks on ${scenario.label} when stop_hook_active is true`, () => {
      const world = scenario.setup();
      try {
        for (const input of [ACTIVE, INACTIVE, ""]) {
          const result = runHook(world, STOP_CHECK, { input });
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).not.toContain("COULD NOT RUN");
          expect(result.stderr).toContain("git add");
        }
      } finally {
        rmSync(world.work, { recursive: true, force: true });
      }
    });
  }

  it("judges the rest of the change when a comma path is present (real gate)", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/new-key.txt");
      write(world, "docs/a,b.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
      expect(result.stderr).toContain("docs/a,b.txt");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges the rest of the change when a backslash path is present (real gate)", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/new-key.txt");
      write(world, "docs/a\\b.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges committed work when a comma path is present (real gate)", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/k.txt");
      git(world.project, "add", "--", "secrets/k.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      write(world, "docs/a,b.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("passes neither unpassable path to the gate, and blocks though the gate passed", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "docs/a,b.txt");
      write(world, "docs/a\\b.txt");
      write(world, "src/ok.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(rawPathsSeen(result.stderr)).toEqual(["./src/ok.txt"]);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks on an unpassable path even when the gate itself exits 2", () => {
    const world = makeWorld({ gateExit: 2 });
    try {
      startSession(world, "startup");
      write(world, "docs/a,b.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks on an unpassable path even when no gate binary resolves", () => {
    const world = makeWorld({ stub: false });
    try {
      startSession(world, "startup");
      write(world, "docs/a,b.txt");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("clears the block on an edited comma file once it is staged, even after a rename", () => {
    const world = makeWorld();
    try {
      write(world, "data/2024,Q1.csv", "a\n");
      git(world.project, "add", "--", "data/2024,Q1.csv");
      git(world.project, "commit", "-q", "-m", "before the session");
      startSession(world, "startup");
      write(world, "data/2024,Q1.csv", "b\n");
      expect(runHook(world, STOP_CHECK, { input: ACTIVE }).code).toBe(2);
      git(world.project, "add", "--", "data/2024,Q1.csv");
      const staged = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(staged.code).toBe(0);
      expect(staged.stdout).toBe("");
      // A rename keeps listing the old name in the index diff; that channel
      // does not cross the command line, so it still clears.
      git(world.project, "mv", "data/2024,Q1.csv", "data/2024-Q1.csv");
      const renamed = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(renamed.code).toBe(0);
      expect(renamed.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks every time on an untracked directory that holds its own repository", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "keys/new.pem");
      git(join(world.project, "keys"), "init", "-q");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("keys/");
      expect(result.stderr).toContain("own git repository");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks every time when the untracked list is too long to pass, and clears once staged", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      const long = "d".repeat(200);
      for (let i = 0; i < 1500; i++) write(world, `docs/${long}-${String(i).padStart(4, "0")}.md`);
      const blocked = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain("too many");
      expect(blocked.stderr).not.toContain("COULD NOT RUN");
      expect(blocked.stdout).toBe("");
      git(world.project, "add", "--", "docs");
      const staged = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(staged.code).toBe(0);
      expect(staged.stderr).toContain("ARG[--staged]");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges against an empty-tree baseline record with the real gate", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/k.txt");
      git(world.project, "add", "--", "secrets/k.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
        cwd: world.project,
        encoding: "utf8",
      }).trim();
      writeFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        `${emptyTree}\nnone\n`,
        "utf8",
      );
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
      expect(result.stderr).not.toContain("COULD NOT RUN");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

describe("stop hook systemMessage is always valid JSON", () => {
  it("parses when the message carries control characters", () => {
    const world = makeWorld();
    try {
      // The record's path is part of the message, and the project directory
      // is named with a carriage return, an 0x01 byte and an escape in it.
      const odd = join(world.work, "proj\r\u0001\u001b[1mx\t\"q\\");
      renameSync(world.project, odd);
      world.project = odd;
      startSession(world, "startup");
      writeFileSync(join(world.project, ".git", "intent-guard-session-start"), "garbage\nnone\n");
      const result = runHook(world, STOP_CHECK, {
        input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }),
      });
      expect(result.code).toBe(0);
      const shown = JSON.parse(result.stdout);
      expect(shown.systemMessage).toContain("COULD NOT RUN");
      expect(shown.systemMessage).not.toMatch(/[\u0000-\u001f]/);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

describe("stop hook path classification", () => {
  const LIB = join(ROOT, "integrations/hooks/conductor-lib.sh");

  function issue(path: string, locale: string): { code: number | null; out: string } {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; intent_guard_path_issue "$(printf "$2")"', "_", LIB, path],
      { encoding: "utf8", env: { ...process.env, LC_ALL: locale } },
    );
    return { code: result.status, out: result.stdout };
  }

  it("sees a backslash that is the trail byte of a Shift-JIS character", () => {
    const locales = spawnSync("locale", ["-a"], { encoding: "utf8" }).stdout ?? "";
    const sjis = locales.split("\n").find((name) => /^ja_JP\.SJIS$/i.test(name));
    if (sjis === undefined) return; // the locale is not installed on this host
    const result = issue("docs/\\225\\\\.txt", sjis);
    expect(result.code).toBe(0);
    expect(result.out).toContain("backslash");
  });

  it("passes an ordinary path", () => {
    expect(issue("docs/plain.txt", "C").code).toBe(1);
  });
});

// Repository-controlled git settings must not change what the Stop hook sees.
// `ignore = all` for a submodule (in .gitmodules or in config) hides a moved
// pointer from a plain diff, and a replace object can make a commit look like
// the baseline.
describe("stop hook and repository git settings", () => {
  const ACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true });
  const INACTIVE_STOP = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });

  /** A real-gate world with a submodule at secrets/vendor, committed before the session. */
  function worldWithSubmodule(): HookWorld {
    const world = makeRealGateWorld();
    const sub = join(world.work, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    git(sub, "config", "user.email", "tester@example.com");
    git(sub, "config", "user.name", "tester");
    writeFileSync(join(sub, "lib.txt"), "v1\n", "utf8");
    git(sub, "add", "--", "lib.txt");
    git(sub, "commit", "-q", "-m", "v1");
    git(world.project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "secrets/vendor");
    git(world.project, "config", "-f", ".gitmodules", "submodule.secrets/vendor.ignore", "all");
    git(world.project, "add", "--", ".gitmodules");
    git(world.project, "commit", "-q", "-m", "add submodule, ignore = all");
    const checkout = join(world.project, "secrets", "vendor");
    git(checkout, "config", "user.email", "tester@example.com");
    git(checkout, "config", "user.name", "tester");
    return world;
  }

  function bump(world: HookWorld): void {
    const checkout = join(world.project, "secrets", "vendor");
    writeFileSync(join(checkout, "lib.txt"), "v2\n", "utf8");
    git(checkout, "commit", "-q", "-am", "v2");
  }

  function revParse(cwd: string, rev: string): string {
    return execFileSync("git", ["rev-parse", rev], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  }

  /**
   * Stage the moved pointer with update-index rather than git add: newer git
   * releases make git add skip a submodule whose .gitmodules entry says
   * ignore = all, so the fixture would silently stage nothing. The check
   * makes such a no-op fail here instead of reaching the hook.
   */
  function stagePointer(world: HookWorld): void {
    const checkout = join(world.project, "secrets", "vendor");
    const moved = revParse(checkout, "HEAD");
    expect(moved).not.toBe(revParse(world.project, "HEAD:secrets/vendor"));
    git(world.project, "update-index", "--cacheinfo", `160000,${moved},secrets/vendor`);
    expect(revParse(world.project, ":secrets/vendor")).toBe(moved);
  }

  function expectHardBlock(world: HookWorld): void {
    const result = runHook(world, STOP_CHECK, { input: ACTIVE });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Budget hard_block");
    expect(result.stderr).toContain("secrets/vendor");
  }

  it("blocks a pointer move committed during the session under ignore = all", () => {
    const world = worldWithSubmodule();
    try {
      startSession(world, "startup");
      bump(world);
      stagePointer(world);
      git(world.project, "commit", "-q", "-m", "bump");
      expectHardBlock(world);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks a staged pointer move under ignore = all", () => {
    const world = worldWithSubmodule();
    try {
      startSession(world, "startup");
      bump(world);
      stagePointer(world);
      expectHardBlock(world);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks a pointer move not yet staged under ignore = all", () => {
    const world = worldWithSubmodule();
    try {
      startSession(world, "startup");
      bump(world);
      expectHardBlock(world);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks an edit to a tracked file inside the submodule checkout", () => {
    const world = worldWithSubmodule();
    try {
      startSession(world, "startup");
      writeFileSync(join(world.project, "secrets", "vendor", "lib.txt"), "edited\n", "utf8");
      expectHardBlock(world);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks a committed pointer move under diff.ignoreSubmodules = all in config", () => {
    const world = worldWithSubmodule();
    try {
      git(world.project, "config", "-f", ".gitmodules", "--unset", "submodule.secrets/vendor.ignore");
      git(world.project, "add", "--", ".gitmodules");
      git(world.project, "commit", "-q", "-m", "drop ignore");
      startSession(world, "startup");
      bump(world);
      stagePointer(world);
      git(world.project, "commit", "-q", "-m", "bump");
      // Set after the commit, so the fixture never depends on whether git
      // add honours it.
      git(world.project, "config", "diff.ignoreSubmodules", "all");
      expectHardBlock(world);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("does not block on untracked build output inside a submodule checkout", () => {
    const world = worldWithSubmodule();
    try {
      startSession(world, "startup");
      writeFileSync(join(world.project, "secrets", "vendor", "build.out"), "x\n", "utf8");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(0);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges a committed change that a replace object maps onto the baseline", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      const baseline = readFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        "utf8",
      ).split("\n")[0];
      write(world, "secrets/k.txt");
      git(world.project, "add", "--", "secrets/k.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      git(world.project, "replace", "-f", "HEAD", baseline);
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges a replaced commit even when repository config turns replace refs on", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      const baseline = readFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        "utf8",
      ).split("\n")[0];
      write(world, "secrets/k.txt");
      git(world.project, "add", "--", "secrets/k.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      // The baseline made to read as HEAD: the record still names an
      // ancestor, and baseline...HEAD compares HEAD with itself.
      git(world.project, "replace", "-f", baseline, "HEAD");
      git(world.project, "config", "core.useReplaceRefs", "true");
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("keeps any git config the host already passes through the environment", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      const probe = join(world.bin, "intent-guard-check");
      writeFileSync(
        probe,
        "#!/usr/bin/env bash\ngit config --get host.marker >&2\ngit config --get core.useReplaceRefs >&2\nexit 0\n",
        "utf8",
      );
      chmodSync(probe, 0o755);
      const result = runHook(world, STOP_CHECK, {
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "host.marker", GIT_CONFIG_VALUE_0: "kept" },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("kept");
      expect(result.stderr).toContain("false");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("judges committed work when a file is named like the baseline range", () => {
    const world = makeRealGateWorld();
    try {
      startSession(world, "startup");
      const baseline = readFileSync(
        join(world.project, ".git", "intent-guard-session-start"),
        "utf8",
      ).split("\n")[0];
      write(world, "secrets/k.txt");
      git(world.project, "add", "--", "secrets/k.txt");
      git(world.project, "commit", "-q", "-m", "agent commit");
      write(world, `${baseline}...HEAD`);
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Budget hard_block");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("is could-not-run, not an empty list, when sorting the changed paths fails", () => {
    const world = makeWorld();
    try {
      startSession(world, "startup");
      write(world, "secrets/new-key.txt");
      const sort = join(world.bin, "sort");
      writeFileSync(sort, "#!/usr/bin/env bash\nexit 1\n", "utf8");
      chmodSync(sort, 0o755);
      const result = runHook(world, STOP_CHECK, { input: INACTIVE_STOP });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("could not collect");
      expect(result.stderr).not.toContain("ARG[");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("replaces a record path that is not a regular file on a new session", () => {
    const world = makeWorld();
    try {
      const record = join(world.project, ".git", "intent-guard-session-start");
      mkdirSync(join(record, "inside"), { recursive: true });
      startSession(world, "startup");
      expect(lstatSync(record).isFile()).toBe(true);
      expect(readFileSync(record, "utf8")).toMatch(/^[0-9a-f]{40}\n/);
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });
});

// A session that began before the repository's first commit records the empty
// tree, and every changed path, committed and staged ones included, has to go
// through --paths. A path that cannot be passed there is could-not-run on this
// route; a finding in what can be passed still blocks every time.
describe("stop hook with an empty-tree baseline", () => {
  const ACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true });
  const INACTIVE = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });

  function emptyTreeWorld(): HookWorld {
    const world = makeRealGateWorld();
    startSession(world, "startup");
    const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
      cwd: world.project,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(world.project, ".git", "intent-guard-session-start"),
      `${emptyTree}\nnone\n`,
      "utf8",
    );
    return world;
  }

  function commitAll(world: HookWorld, ...paths: string[]): void {
    git(world.project, "add", "--", ...paths);
    git(world.project, "commit", "-q", "-m", "work");
  }

  it("still blocks a finding every time when a comma file is committed beside it", () => {
    const world = emptyTreeWorld();
    try {
      write(world, "secrets/k.txt");
      write(world, "data/2024,Q1.csv");
      commitAll(world, "secrets/k.txt", "data/2024,Q1.csv");
      for (const input of [ACTIVE, ACTIVE, INACTIVE]) {
        const result = runHook(world, STOP_CHECK, { input });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("Budget hard_block");
        expect(result.stdout).toBe("");
      }
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks once on a committed comma file, then lets the active stop through loudly", () => {
    const world = emptyTreeWorld();
    try {
      write(world, "data/2024,Q1.csv");
      commitAll(world, "data/2024,Q1.csv");
      expect(runHook(world, STOP_CHECK, { input: INACTIVE }).code).toBe(2);
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("COULD NOT RUN");
      expect(result.stderr).toContain("data/2024,Q1.csv");
      expect(result.stderr).toContain("new session");
      expect(result.stderr).not.toContain("git add");
      expect(result.stderr).not.toContain("unstaged and untracked");
      expect(JSON.parse(result.stdout).systemMessage).toContain("COULD NOT RUN");
    } finally {
      rmSync(world.work, { recursive: true, force: true });
    }
  });

  it("blocks once on a list too long to pass, then lets the active stop through loudly", () => {
    const world = emptyTreeWorld();
    try {
      const long = "d".repeat(200);
      for (let i = 0; i < 1500; i++) write(world, `docs/${long}-${String(i).padStart(4, "0")}.md`);
      commitAll(world, "docs");
      expect(runHook(world, STOP_CHECK, { input: INACTIVE }).code).toBe(2);
      const result = runHook(world, STOP_CHECK, { input: ACTIVE });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("too many");
      expect(result.stderr).not.toContain("git add");
      expect(result.stderr).not.toContain("unstaged and untracked");
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
