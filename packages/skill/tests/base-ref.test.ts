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
  const contractFile = join(dir, ".conductor", "intent-contract.yaml");
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

  it("fails closed with exit 2 on an unknown base ref", async () => {
    const dir = repoWithBranch(["README.md"]);
    await freezeWithBudget(dir, "\nbudget:\n  max_files: 5\n");

    const res = await run("check-cli.js", ["--project", dir, "--base", "no-such-ref", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no-such-ref");
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("fails closed with exit 2 outside a git repository", async () => {
    const dir = tmpDir();
    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("main");
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
});
