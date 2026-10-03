import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cli: string, args: string[], cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [join(DIST, cli), ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr ?? "") };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

beforeAll(() => {
  if (!existsSync(join(DIST, "check-cli.js"))) {
    throw new Error("dist not built - run `pnpm build` before tests");
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function writeAt(dir: string, relative: string, body: string): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-base-"));
}

/**
 * A git repo with one commit on main and a feature branch whose single commit
 * touches exactly the given paths. This is the pull-request shape --base is for.
 */
function repoWithBranch(changed: string[]): string {
  const dir = tmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  git(dir, ["add", "--", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
  git(dir, ["checkout", "-b", "feature"]);
  for (const relative of changed) {
    writeAt(dir, relative, `touched ${relative}\n`);
    git(dir, ["add", "--", relative]);
  }
  git(dir, ["commit", "-m", "work"]);
  return dir;
}

/**
 * A repo whose feature branch renames one committed file. Git detects the
 * rename and, left to itself, reports only the destination path.
 */
function repoWithRename(from: string, to: string, commitRename: boolean): string {
  const dir = tmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  writeAt(dir, from, "keep me exactly as I am\n");
  git(dir, ["add", "--", "README.md", from]);
  git(dir, ["commit", "-m", "initial"]);
  git(dir, ["checkout", "-b", "feature"]);
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  git(dir, ["mv", from, to]);
  if (commitRename) git(dir, ["commit", "-m", "rename"]);
  return dir;
}

/** Land a commit on main after the feature branch already forked from it. */
function advanceMain(dir: string, relative: string): void {
  git(dir, ["checkout", "main"]);
  writeAt(dir, relative, `landed on main ${relative}\n`);
  git(dir, ["add", "--", relative]);
  git(dir, ["commit", "-m", "main moves on"]);
  git(dir, ["checkout", "feature"]);
}

const DOCS_ASK =
  "Update the readme usage docs. Do not change source. Done when one usage example is documented.";

async function freezeWithBudget(dir: string, budgetYaml: string): Promise<void> {
  await run("extract-cli.js", ["--project", dir, "--text", DOCS_ASK]);
  await run("freeze-cli.js", ["--project", dir, "--approved-by", "tester"]);
  const contractFile = join(dir, ".intent-guard", "intent-contract.yaml");
  writeFileSync(contractFile, readFileSync(contractFile, "utf8") + budgetYaml, "utf8");
}

describe("intent-guard check --base", { timeout: 60_000 }, () => {
  it("collects branch paths from the base ref and blocks a protected path", async () => {
    const dir = repoWithBranch(["src/legacy/error-format.ts"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("blocked");
    expect(out.budget.action).toBe("hard_block");
    expect(JSON.stringify(out.budget.violations)).toContain("src/legacy/error-format.ts");
  });

  it("passes when the branch only touches allowed paths", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(out.budget.ok).toBe(true);
  });

  it("unions --base with --paths and counts a repeated path once", async () => {
    const dir = repoWithBranch(["README.md", "src/legacy/error-format.ts"]);
    // Two load-bearing halves. The protected path only blocks if the base ref
    // paths reached the gate; max_files: 2 only holds if README.md, named by
    // both --base and --paths, is counted once.
    await freezeWithBudget(
      dir,
      '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n  max_files: 2\n',
    );

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--paths", "README.md",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const violations = JSON.parse(res.stdout).budget.violations as { rule: string }[];
    expect(JSON.stringify(violations)).toContain("src/legacy/error-format.ts");
    expect(violations.map((violation) => violation.rule)).not.toContain("max_files");
  });

  it("ignores commits that landed on the base after the branch forked", async () => {
    const dir = repoWithBranch(["README.md"]);
    // Only the merge base view is correct for a pull request. A two-dot diff
    // would attribute this later main-only file to the branch and block.
    advanceMain(dir, "src/legacy/landed-on-main.ts");
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(JSON.stringify(out.budget)).not.toContain("landed-on-main");
  });

  it("lists both sides of a rename out of a protected directory", async () => {
    const dir = repoWithRename("src/legacy/keeper.ts", "src/new/keeper.ts", true);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.budget.action).toBe("hard_block");
    expect(JSON.stringify(out.budget.violations)).toContain("src/legacy/keeper.ts");
  });

  it("lists both sides of a staged rename out of a protected directory", async () => {
    const dir = repoWithRename("src/legacy/keeper.ts", "src/new/keeper.ts", false);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.budget.action).toBe("hard_block");
    expect(JSON.stringify(out.budget.violations)).toContain("src/legacy/keeper.ts");
  });

  it("judges a branch that adds a file named like the range it is diffed with", async () => {
    // "git diff main...HEAD" with a file of that exact name in the tree is
    // ambiguous to git unless the revisions are ended with "--".
    const dir = repoWithBranch(["main...HEAD", "src/legacy/error-format.ts"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.budget.action).toBe("hard_block");
    expect(JSON.stringify(out.budget.violations)).toContain("src/legacy/error-format.ts");
  });

  it("fails closed with exit 2 on an unknown base ref", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");

    const res = await run("check-cli.js", ["--project", dir, "--base", "no-such-ref", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no-such-ref");
    expect(res.stdout).not.toContain('"status":"ok"');
    // One line, as documented: git's own multi-line stderr is not forwarded.
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("fails closed with exit 2 outside a git repository", async () => {
    const dir = tmpDir();
    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("main");
    // git prints its whole usage screen here; only its first line may survive.
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("treats --base with no ref value as a usage error", async () => {
    const dir = repoWithBranch(["README.md"]);
    const res = await run("check-cli.js", ["--project", dir, "--base"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Usage: intent-guard check");
  });

  it("treats a flag after --base as a missing ref value", async () => {
    const dir = repoWithBranch(["README.md"]);
    const res = await run("check-cli.js", ["--project", dir, "--base", "--json"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Usage: intent-guard check");
  });

  // Git reads a revision that starts with a dash as an option: "-Sxyz...HEAD"
  // is a pickaxe search, which lists nothing, and an empty list passes. -R
  // reverses the diff but lists the same names, so the assertion is on the
  // refusal message, not on the exit code alone.
  for (const ref of ["-Sxyz", "-Gnomatch", "-O/dev/null", "-p", "-R"]) {
    it(`refuses a --base value that starts with a dash (${ref}) as could-not-run`, async () => {
      const dir = repoWithBranch(["src/legacy/error-format.ts"]);
      await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

      const res = await run("check-cli.js", ["--project", dir, "--base", ref, "--json"]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("starts with a dash");
      expect(res.stdout).not.toContain('"status":"ok"');
    });
  }

  it("refuses a dash-leading ref inside basePaths itself, not only in the caller", async () => {
    const dir = repoWithBranch(["src/legacy/error-format.ts"]);
    const module = join(DIST, "changed-paths.js");
    const script =
      `import { basePaths } from ${JSON.stringify(module)};\n` +
      `const out = basePaths(${JSON.stringify(dir)}, "-Sxyz");\n` +
      `console.log("RETURNED " + JSON.stringify(out));\n`;
    let code = 0;
    let stdout = "";
    let stderr = "";
    try {
      const res = await execFileAsync("node", ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      stdout = String(res.stdout);
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      code = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    expect(stdout).not.toContain("RETURNED");
    expect(code).toBe(2);
    expect(stderr).toContain("starts with a dash");
  });
});

/**
 * A repo whose main branch registers a submodule at secrets/vendor. `ignore`
 * in .gitmodules, or diff.ignoreSubmodules in config, makes a plain git diff
 * leave a moved submodule pointer out of its listing.
 */
function repoWithSubmodule(): string {
  const sub = tmpDir();
  git(sub, ["init", "-b", "main"]);
  git(sub, ["config", "user.email", "tester@example.com"]);
  git(sub, ["config", "user.name", "tester"]);
  writeAt(sub, "lib.txt", "v1\n");
  git(sub, ["add", "--", "lib.txt"]);
  git(sub, ["commit", "-m", "v1"]);

  const dir = tmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  git(dir, ["add", "--", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
  git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "secrets/vendor"]);
  git(dir, ["commit", "-m", "add submodule"]);
  return dir;
}

function ignoreAllInGitmodules(dir: string): void {
  git(dir, ["config", "-f", ".gitmodules", "submodule.secrets/vendor.ignore", "all"]);
  git(dir, ["add", "--", ".gitmodules"]);
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/**
 * Commit inside the submodule checkout and stage the moved pointer.
 *
 * The pointer is written straight into the index with update-index rather
 * than git add: newer git releases make git add skip a submodule whose
 * .gitmodules entry says ignore = all, so the fixture would silently stage
 * nothing and every assertion after it would be about an unchanged repo.
 * The check at the end makes such a no-op fail loudly here instead.
 */
function bumpSubmodule(dir: string): void {
  const checkout = join(dir, "secrets", "vendor");
  git(checkout, ["config", "user.email", "tester@example.com"]);
  git(checkout, ["config", "user.name", "tester"]);
  const before = gitOut(dir, ["rev-parse", ":secrets/vendor"]);
  writeAt(checkout, "lib.txt", "v2\n");
  git(checkout, ["commit", "-am", "v2"]);
  const moved = gitOut(checkout, ["rev-parse", "HEAD"]);
  git(dir, ["update-index", "--cacheinfo", `160000,${moved},secrets/vendor`]);
  expect(moved).not.toBe(before);
  expect(gitOut(dir, ["rev-parse", ":secrets/vendor"])).toBe(moved);
}

describe("a moved submodule pointer is always listed", { timeout: 60_000 }, () => {
  const PROTECT = '\nbudget:\n  protected_paths:\n    - "secrets/**"\n';

  async function expectBlocked(dir: string, mode: string[]): Promise<void> {
    const res = await run("check-cli.js", ["--project", dir, ...mode, "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.stringify(JSON.parse(res.stdout).budget.violations)).toContain("secrets/vendor");
  }

  it("--base, when the branch sets ignore = all and moves the pointer", async () => {
    const dir = repoWithSubmodule();
    git(dir, ["checkout", "-b", "feature"]);
    ignoreAllInGitmodules(dir);
    bumpSubmodule(dir);
    git(dir, ["commit", "-m", "bump"]);
    await freezeWithBudget(dir, PROTECT);
    await expectBlocked(dir, ["--base", "main"]);
  });

  it("--base, when the base already has ignore = all and the branch only moves the pointer", async () => {
    const dir = repoWithSubmodule();
    ignoreAllInGitmodules(dir);
    git(dir, ["commit", "-m", "ignore all"]);
    git(dir, ["checkout", "-b", "feature"]);
    bumpSubmodule(dir);
    git(dir, ["commit", "-m", "bump"]);
    await freezeWithBudget(dir, PROTECT);
    await expectBlocked(dir, ["--base", "main"]);
  });

  it("--staged, with ignore = all in .gitmodules", async () => {
    const dir = repoWithSubmodule();
    ignoreAllInGitmodules(dir);
    git(dir, ["commit", "-m", "ignore all"]);
    bumpSubmodule(dir);
    await freezeWithBudget(dir, PROTECT);
    await expectBlocked(dir, ["--staged"]);
  });

  it("--staged, with diff.ignoreSubmodules = all in the repository config", async () => {
    const dir = repoWithSubmodule();
    git(dir, ["config", "diff.ignoreSubmodules", "all"]);
    bumpSubmodule(dir);
    await freezeWithBudget(dir, PROTECT);
    await expectBlocked(dir, ["--staged"]);
  });
});

// Git C-quotes a path containing a double quote, a backslash, a tab or a newline
// even with core.quotePath=false, so a line-split reader sees `"secrets/a\"b.txt"`
// (leading quote, escaped inside) and no glob matches it. The fix is NUL-separated
// output (-z), which git never quotes.
const AWKWARD_NAMES: [string, string][] = [
  ["double quote", 'secrets/a"b.txt'],
  ["backslash", "secrets/a\\b.txt"],
  ["tab", "secrets/a\tb.txt"],
];

describe("NUL-separated path collection", { timeout: 60_000 }, () => {
  for (const [label, name] of AWKWARD_NAMES) {
    it(`hard-blocks a ${label} file name in a protected dir with --base`, async () => {
      const dir = repoWithBranch([name]);
      await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "secrets/**"\n');

      const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
      expect(res.code).toBe(1);
      const out = JSON.parse(res.stdout);
      expect(out.budget.action).toBe("hard_block");
      expect(out.budget.violations[0].matched).toContain(name);
    });

    it(`hard-blocks a ${label} file name in a protected dir with --staged`, async () => {
      const dir = repoWithBranch(["README.md"]);
      await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "secrets/**"\n');
      writeAt(dir, name, "key\n");
      git(dir, ["add", "--", name]);

      const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
      expect(res.code).toBe(1);
      const out = JSON.parse(res.stdout);
      expect(out.budget.action).toBe("hard_block");
      expect(out.budget.violations[0].matched).toContain(name);
    });
  }
});

// The glob regexp had no `s` flag, so the `.*` built from `**` stopped at a
// newline and a name like secrets/a\nb.txt matched no protected glob.
describe("newline in a file name", { timeout: 60_000 }, () => {
  const NEWLINE_NAME = "secrets/a\nb.txt";
  const BUDGET = '\nbudget:\n  protected_paths:\n    - "secrets/**"\n';

  it("hard-blocks --base", async () => {
    const dir = repoWithBranch([NEWLINE_NAME]);
    await freezeWithBudget(dir, BUDGET);
    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });

  it("hard-blocks --staged", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, BUDGET);
    writeAt(dir, NEWLINE_NAME, "key\n");
    git(dir, ["add", "--", NEWLINE_NAME]);
    const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });

  it("hard-blocks --paths", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, BUDGET);
    const res = await run("check-cli.js", ["--project", dir, "--paths", NEWLINE_NAME, "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });

  it("hard-blocks a staged rename of such a file out of secrets/", async () => {
    const dir = repoWithRename(NEWLINE_NAME, "docs/moved.txt", false);
    await freezeWithBudget(dir, BUDGET);
    const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });

  it("hard-blocks a committed rename of such a file out of secrets/ with --base", async () => {
    const dir = repoWithRename(NEWLINE_NAME, "docs/moved.txt", true);
    await freezeWithBudget(dir, BUDGET);
    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });
});

describe("staged path listing does not swallow errors", { timeout: 120_000 }, () => {
  it("still blocks when the staged name list is larger than 1 MB", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/secrets/**"\n');
    // About 1.3 MB of names, a real list rather than an injected buffer size.
    // execFileSync's default maxBuffer is 1 MB, which threw ENOBUFS, and the
    // catch-all turned that into an empty list, which passes.
    const pad = "p".repeat(80);
    for (let i = 0; i < 14000; i++) {
      writeAt(dir, `bulk/${pad}${String(i).padStart(6, "0")}.txt`, "x\n");
    }
    writeAt(dir, "zzz/secrets/key.txt", "key\n");
    git(dir, ["add", "--", "bulk", "zzz"]);
    const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).budget.action).toBe("hard_block");
  });

  it("passes quietly outside a git repository, as before", async () => {
    const dir = tmpDir();
    const res = await run("check-cli.js", ["--project", dir, "--staged", "--no-require-frozen", "--json"]);
    expect(res.code).toBe(0);
  });

  it("exits 2 on any other git failure", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");
    // A corrupt index makes git diff --cached fail for a reason that is not
    // "not a git repository".
    writeFileSync(join(dir, ".git", "index"), "this is not an index", "utf8");
    const res = await run("check-cli.js", ["--project", dir, "--staged", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stdout).not.toContain('"status":"ok"');
    expect(res.stderr).toContain("--staged");
  });
});

describe("explicit path shapes are refused like budget globs", { timeout: 60_000 }, () => {
  const REFUSED: [string, string][] = [
    ["a leading ./ followed by another . segment", "././secrets/k"],
    ["an empty segment after ./", ".//secrets/k"],
    ["an internal empty segment", "secrets//k"],
    ["a leading slash", "/secrets/k"],
    ["a backslash", "secrets\\k"],
  ];
  for (const [label, value] of REFUSED) {
    it(`refuses ${label}`, async () => {
      const dir = repoWithBranch(["README.md"]);
      await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "secrets/**"\n');
      const res = await run("check-cli.js", ["--project", dir, "--paths", value, "--json"]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain(value);
      expect(res.stdout).not.toContain('"status":"ok"');
    });
  }

  it("still accepts a single leading ./ and a trailing slash", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");
    const res = await run("check-cli.js", ["--project", dir, "--paths", "./README.md,docs/", "--json"]);
    expect(res.code).toBe(0);
  });

  it("treats ./secrets/k as the protected path it is", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "secrets/**"\n');
    const res = await run("check-cli.js", ["--project", dir, "--paths", "./secrets/k", "--json"]);
    expect(res.code).toBe(1);
  });
});

describe("dot-dot path refusal", { timeout: 60_000 }, () => {
  it("refuses a --paths entry with a .. segment instead of letting it slip past a protected glob", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "secrets/**"\n');

    const res = await run("check-cli.js", [
      "--project", dir,
      "--paths", "src/../secrets/k",
      "--json",
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("src/../secrets/k");
    expect(res.stderr).toContain("..");
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("refuses a leading .. segment too, in report", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");
    const res = await run("report-cli.js", ["--project", dir, "--paths", "../outside.txt", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("../outside.txt");
  });

  it("still accepts a name that merely contains dots", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");
    const res = await run("check-cli.js", ["--project", dir, "--paths", "docs/a..b.md,notes/..hidden", "--json"]);
    expect(res.code).toBe(0);
  });
});

describe("intent-guard report --base", { timeout: 60_000 }, () => {
  it("reports the same path set the gate saw", async () => {
    const dir = repoWithBranch(["README.md", "docs/usage.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 1\n");

    const report = await run("report-cli.js", ["--project", dir, "--base", "main", "--json"]);
    const reported = JSON.parse(report.stdout);
    expect([...reported.changed_paths].sort()).toEqual(["README.md", "docs/usage.md"]);

    const check = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(check.code).toBe(1);
    const gate = JSON.parse(check.stdout);
    expect(JSON.stringify(gate.budget.violations)).toContain("Changed 2 files");
  });

  it("puts explicit --paths first and lists a repeated path once", async () => {
    const dir = repoWithBranch(["README.md", "docs/usage.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 9\n");

    const res = await run("report-cli.js", [
      "--project", dir,
      "--base", "main",
      "--paths", "extra/note.md,README.md",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.changed_paths).toEqual(["extra/note.md", "README.md", "docs/usage.md"]);
  });

  it("keeps a spaced and a non-ASCII path literal", async () => {
    const dir = repoWithBranch(["docs/a note.md", "docs/café.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 9\n");

    const res = await run("report-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(0);
    const paths: string[] = JSON.parse(res.stdout).changed_paths;
    // Quoted or octal-escaped output means core.quotePath=false was dropped.
    expect(paths.every((path) => !path.startsWith('"'))).toBe(true);
    expect(paths.every((path) => !path.includes("\\3"))).toBe(true);
    const normalized = paths.map((path) => path.normalize("NFC"));
    expect(normalized).toContain("docs/a note.md");
    expect(normalized).toContain("docs/café.md");
  });

  it("fails closed with exit 2 on an unknown base ref", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");

    const res = await run("report-cli.js", ["--project", dir, "--base", "ghost-branch", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("ghost-branch");
  });

  it("treats --base with no ref value as a usage error", async () => {
    const dir = repoWithBranch(["README.md"]);
    const res = await run("report-cli.js", ["--project", dir, "--base"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Usage: intent-guard report");
  });

  it("refuses a --base value that starts with a dash as could-not-run", async () => {
    const dir = repoWithBranch(["src/legacy/error-format.ts"]);
    await freezeWithBudget(dir, '\nbudget:\n  protected_paths:\n    - "**/legacy/**"\n');

    const res = await run("report-cli.js", ["--project", dir, "--base", "-Sxyz", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("starts with a dash");
  });
});
