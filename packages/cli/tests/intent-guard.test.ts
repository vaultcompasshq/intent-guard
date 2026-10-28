import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = join(import.meta.dirname, "..", "dist");
const CLI = join(DIST, "intent-guard.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-unified-cli-"));
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error("dist not built - run `pnpm build` before tests");
  }
});

describe("intent-guard", () => {
  it("prints top-level help", () => {
    const res = run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: intent-guard <command> [flags]");
    expect(res.stdout).toContain("intent-guard check --project . --staged");
  });

  it("passes --help through to a subcommand instead of running it", () => {
    // The 1.1.0 papercut: these two ran the gate against the current
    // directory and exited with its result.
    for (const command of ["check", "report"]) {
      const dir = tmpProject();
      const res = run([command, "--help"], dir);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`Usage: intent-guard ${command}`);
      expect(res.stdout).not.toContain("Intent Guard gate:");
    }
  });

  it("accepts a leading pnpm argument separator", () => {
    const res = run(["--", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: intent-guard <command> [flags]");
  });

  it("prints the package version", () => {
    const dir = tmpProject();
    const res = run(["--version"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("1.10.2\n");
    expect(res.stderr).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("prints the package version for -v too", () => {
    const dir = tmpProject();
    const res = run(["-v"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("1.10.2\n");
    expect(res.stderr).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dispatches to an existing subcommand", () => {
    const res = run(["coach", "just quickly add export like notion"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.needs_coaching).toBe(true);
  });

  it("runs init through the unified binary", () => {
    const dir = tmpProject();
    const res = run(["init", "--project", dir]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).created).toContain(".intent-guard/config.yaml");
    expect(existsSync(join(dir, ".intent-guard", "config.yaml"))).toBe(true);
  });

  it("runs doctor through the unified binary", () => {
    const dir = tmpProject();
    const res = run(["doctor", "--project", dir, "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("error");
    expect(out.findings.some((f: { id: string }) => f.id === "conductor_not_initialized")).toBe(true);
  });

  it("runs report through the unified binary", () => {
    const dir = tmpProject();
    run([
      "extract",
      "--project",
      dir,
      "--text",
      "Update README usage docs. Do not change source code or package metadata. Verify README includes one usage example.",
    ]);
    run(["freeze", "--project", dir, "--approved-by", "tester"]);

    const res = run([
      "report",
      "--project",
      dir,
      "--paths",
      "README.md",
      "--signals",
      "README documentation update",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(out.contract.approved_by).toBe("tester");
  });

  it("installs the pre-commit hook through the unified binary", () => {
    const dir = tmpProject();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const res = run(["hook", "install", "--project", dir, "--with-vault-guard"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.installed).toBe(true);
    const hook = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toContain("conductor-managed-pre-commit");
    expect(hook).toContain("vault-guard scan --staged");
  });

  it("runs rules audit through the unified binary", () => {
    const dir = tmpProject();
    writeFileSync(join(dir, "AGENTS.md"), "## Rules\n- Never commit secrets\n", "utf8");
    writeFileSync(join(dir, "CLAUDE.md"), "## Rules\n- NEVER commit secrets\n", "utf8");

    const res = run(["rules", "audit", "--project", dir, "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.summary.duplicates).toBe(1);
  });

  it("runs import-spec through the unified binary", () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "theme-toggle");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "requirements.md"),
      "WHEN a user toggles theme, THE SYSTEM SHALL persist the preference.\n",
      "utf8",
    );
    writeFileSync(join(specDir, "design.md"), "Use existing settings storage.\n", "utf8");
    writeFileSync(join(specDir, "tasks.md"), "- [ ] Add theme toggle\n", "utf8");

    const res = run([
      "import-spec",
      "--project",
      dir,
      "--from",
      "kiro",
      "--spec-dir",
      ".kiro/specs/theme-toggle",
    ]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.format).toBe("kiro");
    expect(out.written_path).toContain("intent-contract.yaml");
    expect(readFileSync(out.written_path, "utf8")).not.toContain("approval:");
  });

  it("supports drift --ci with a blocking exit code", () => {
    const dir = tmpProject();
    const contractPath = join(dir, "intent-contract.yaml");
    writeFileSync(
      contractPath,
      `contract_id: ic-20260704-clici0
version: "1.0.0"
original_ask: "Add CSV export for the fund performance table."
in_scope:
  - "Client-side CSV export of fund table"
out_of_scope:
  - "New API endpoints"
constraints:
  - source: AGENTS.md
    rule: "No new API endpoints without explicit approval"
    priority: critical
acceptance_criteria:
  - id: ac-1
    description: "Export downloads CSV"
    testable: true
frozen_at: "2026-06-17T14:30:00Z"
frozen_by: user
pivot_log: []
metadata:
  project: conductor
`,
    );

    const res = run([
      "drift",
      "--ci",
      "--contract",
      contractPath,
      "--project",
      dir,
      "--paths",
      "src/app/api/export/route.ts",
      "--signals",
      "new api endpoint",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toBe("");
    expect(res.stdout).not.toBe("");
    const out = JSON.parse(res.stdout);
    expect(out.block).toBe(true);
    expect(readFileSync(contractPath, "utf8")).toContain("ic-20260704-clici0");
  });
});

describe("a rule that names a file in markdown blocks a staged edit of that file", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  }

  function repo(): string {
    const dir = tmpProject();
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "tester@example.com"]);
    git(dir, ["config", "user.name", "tester"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "README.md"), "# Project\n", "utf8");
    git(dir, ["add", "--", "README.md"]);
    git(dir, ["commit", "-m", "initial"]);
    return dir;
  }

  // Blocked in 1.9.0, passed in 1.10.0 (the closed file-name rule read
  // **CHANGELOG.md**. as a word that names no file), blocks again.
  it.each([
    ["Add CSV export to the reports page. Do not edit **CHANGELOG.md**.", "CHANGELOG.md"],
    ["Add CSV export to the reports page. Do not modify **payment**_methods.", "db/payment_methods.sql"],
    // Blocked in 1.9.0, passed in 1.10.1 (2026-10-27 B1), block again.
    ["Add CSV export to the reports page. **Never touch the Dockerfile.**", "Dockerfile"],
    ["Add CSV export to the reports page. *Do not edit CHANGELOG.md.*", "CHANGELOG.md"],
    // Curly double quotes (U+201C, U+201D), built from code points so this
    // file stays ASCII.
    [`Add CSV export to the reports page. Do not edit ${String.fromCodePoint(0x201c)}Makefile${String.fromCodePoint(0x201d)}.`, "Makefile"],
    [`Add CSV export to the reports page. Do not edit ${String.fromCodePoint(0x201c)}CODEOWNERS${String.fromCodePoint(0x201d)}.`, ".github/CODEOWNERS"],
    ["Add CSV export to the reports page. Do not modify payment\\_methods.", "db/payment_methods.sql"],
    ["Add CSV export to the reports page. Do not edit <code>Makefile</code>.", "Makefile"],
    ["Add CSV export to the reports page. Do not modify __payment_methods__.", "db/payment_methods.sql"],
    // Blocked in 1.9.0 and 1.10.1, passed on the first B1 fix (its review's
    // M1: the edge trim took the glob's own star), block again.
    ["Add CSV export to the reports page. Never commit '*.pem'.", "certs/server.pem"],
    ["Add CSV export to the reports page. Never commit (*.pem).", "certs/server.pem"],
    ['Add CSV export to the reports page. Never commit "*.pem" files.', "certs/server.pem"],
  ])("extract %j, freeze, stage %s: check --staged exits 1", (ask, path) => {
    const dir = repo();
    expect(run(["extract", "--project", dir, "--text", ask]).code).toBe(0);
    expect(run(["freeze", "--project", dir, "--approved-by", "tester"]).code).toBe(0);
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), "changed\n", "utf8");
    git(dir, ["add", "--", path]);
    const res = run(["check", "--project", dir, "--staged"]);
    expect(res.stdout).not.toContain("Intent Guard gate: ok");
    expect(res.code).toBe(1);
  });
});

describe("import-spec keeps an explicit prohibition written as a Gherkin step", () => {
  // Blocked in 1.9.0, passed in 1.10.0 (the whole scenario was dropped).
  it("imports Then SHALL NOT and And must never as out_of_scope, and check blocks on them", () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "requirements.md"),
      [
        "# Requirements",
        "",
        "## Requirement 1: Export",
        "",
        "Scenario: export a report",
        "  Given a saved report",
        "  When I export it",
        "  Then the system SHALL NOT email the file",
        "  And the exporter must never write to the audit log",
        "",
      ].join("\n"),
      "utf8",
    );
    const imported = run(["import-spec", "--project", dir, "--from", "kiro", "--spec-dir", ".kiro/specs/export"]);
    expect(imported.code).toBe(0);
    const draft = readFileSync(join(dir, ".intent-guard", "intent-contract.yaml"), "utf8");
    expect(draft).toContain("SHALL NOT email the file");
    expect(draft).toContain("never write to the audit log");
    expect(run(["freeze", "--project", dir, "--approved-by", "tester"]).code).toBe(0);
    const res = run(["check", "--project", dir, "--paths", "src/email/send.ts"]);
    expect(res.stdout).not.toContain("Intent Guard gate: ok");
    expect(res.code).toBe(1);
  });
});
