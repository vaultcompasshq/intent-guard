import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cli: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [join(DIST, cli), ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr ?? "") };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ig-quality-cli-"));
}

beforeAll(() => {
  if (!existsSync(join(DIST, "extract-cli.js"))) {
    throw new Error("dist not built -- run `pnpm build` before tests");
  }
});

describe("extract --verbose", () => {
  it("says which near-duplicate rule each kept rule replaced, on stderr", async () => {
    const dir = tmpProject();
    writeFileSync(join(dir, "AGENTS.md"), "- Never commit secrets\n", "utf8");
    writeFileSync(join(dir, "CLAUDE.md"), "- Never commit secrets at all\n", "utf8");
    const res = await run("extract-cli.js", [
      "--project", dir,
      "--text", "Add CSV export. Never touch billing. Do not touch billing.",
      "--dry-run",
      "--verbose",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('replaced: "Never touch billing" (kept "Do not touch billing")');
    expect(res.stderr).toContain('replaced: "Never commit secrets" (kept "Never commit secrets at all")');
    const out = JSON.parse(res.stdout);
    expect(out.replaced).toHaveLength(2);
  });

  it("prints no replacement lines without --verbose", async () => {
    const dir = tmpProject();
    const res = await run("extract-cli.js", [
      "--project", dir,
      "--text", "Add CSV export. Never touch billing. Do not touch billing.",
      "--dry-run",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain("replaced:");
  });
});

describe("path budget suggestions", () => {
  it("extract prints suggested allowed_paths and writes no budget", async () => {
    const dir = tmpProject();
    mkdirSync(join(dir, "src", "parser"), { recursive: true });
    const res = await run("extract-cli.js", ["--project", dir, "--text", "Fix the tokenizer in src/parser/ and update README.md.", "--dry-run"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.suggested_allowed_paths).toEqual(["src/parser/**", "README.md"]);
    expect(out.contract_yaml).not.toContain("budget:");
    expect(res.stderr).toContain("suggestion: budget.allowed_paths could be src/parser/**, README.md (not written");
  });

  it("import-spec suggests from the labelled sections", async () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "requirements.md"), "## Scope\n\n- Add the export button in src/report/\n", "utf8");
    const res = await run("import-spec-cli.js", ["--project", dir, "--from", "kiro", "--spec-dir", ".kiro/specs/export", "--dry-run"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.suggested_allowed_paths).toEqual(["src/report/**"]);
    expect(out.contract_yaml).not.toContain("budget:");
  });
});

describe("import-spec with no labelled section", () => {
  it("warns on stderr and in JSON, names the headings, and lists the sections it read", async () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "requirements.md"), "# Export\n\nNever ship PDF export.\n", "utf8");
    const res = await run("import-spec-cli.js", ["--project", dir, "--from", "kiro", "--spec-dir", ".kiro/specs/export", "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/^warning: No labelled scope section found in requirements\.md\./m);
    const out = JSON.parse(res.stdout);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("Non-goals");
    expect(out.sections).toEqual([]);
    expect(out.review.out_of_scope).toEqual([]);
  });
});

describe("import-spec --verbose", () => {
  it("says which out_of_scope item each kept item replaced", async () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "requirements.md"),
      ["# Requirements", "", "- Add the CSV export button", "", "## Out of scope", "", "- PDF export", "- Do not add any PDF export"].join(
        "\n",
      ),
      "utf8",
    );
    const res = await run("import-spec-cli.js", [
      "--project", dir,
      "--from", "kiro",
      "--spec-dir", ".kiro/specs/export",
      "--dry-run",
      "--verbose",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('replaced: "PDF export" (kept "Do not add any PDF export")');
  });
});
