import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

// Every command the unified CLI dispatches to, by its skill bin.
const CLIS = [
  "brief-cli.js",
  "check-cli.js",
  "coach-cli.js",
  "correct-cli.js",
  "doctor-cli.js",
  "drift-cli.js",
  "extract-cli.js",
  "freeze-cli.js",
  "hook-cli.js",
  "import-spec-cli.js",
  "index-cli.js",
  "init-cli.js",
  "pivot-cli.js",
  "report-cli.js",
  "resume-cli.js",
  "rules-cli.js",
];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cli: string, args: string[], cwd: string): Promise<RunResult> {
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
    throw new Error("dist not built — run `pnpm build` before tests");
  }
});

describe("subcommand help", () => {
  for (const cli of CLIS) {
    // An empty directory with no .conductor: a command that actually ran here
    // would either fail the gate, write a skeleton, or both. Help must do
    // neither.
    it(`${cli} --help prints usage, exits 0, and touches nothing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-help-"));
      const res = await run(cli, ["--help"], dir);

      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^Usage: /m);
      expect(readdirSync(dir)).toEqual([]);
    });

    it(`${cli} -h prints the same usage`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-help-"));
      const long = await run(cli, ["--help"], dir);
      const short = await run(cli, ["-h"], dir);

      expect(short.code).toBe(0);
      expect(short.stdout).toBe(long.stdout);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  // The two the 2026-09-02 published-artifact run actually caught. Kept as
  // named cases so a regression is legible in the test output.
  it("check --help does not run the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-help-check-"));
    const res = await run("check-cli.js", ["--help"], dir);
    expect(res.code).toBe(0);
    // The gate's own verdict lines, not the word "gate", which usage uses.
    expect(res.stdout).not.toMatch(/Intent Guard gate:/);
    expect(res.stderr).toBe("");
  });

  it("report --help does not build a report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-help-report-"));
    const res = await run("report-cli.js", ["--help"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/^# Intent Guard report/m);
    expect(res.stderr).toBe("");
  });

  it("takes --help as a flag, not as a flag's value", async () => {
    // `--message --help` means the message is the literal string "--help".
    // That is a real run, so it must not print usage. A naive
    // argv.includes("--help") would get this wrong.
    const dir = mkdtempSync(join(tmpdir(), "conductor-help-value-"));
    const res = await run("check-cli.js", ["--message", "--help"], dir);
    expect(res.stdout).not.toMatch(/^Usage: /m);
    expect(res.stderr).not.toMatch(/^Usage: /m);
  });
});
