import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

async function run(
  cli: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [join(DIST, cli), ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
      ...(env ? { env } : {}),
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

/**
 * A PATH directory containing only a real node (symlinked, since the child
 * process resolves "node" through the PATH we hand it, not ours) and a stub
 * git that appends its argv to a log file instead of doing anything. A run
 * that never shells out to git leaves that log file missing entirely; one
 * that does leaves a line behind naming exactly what it called git with.
 */
function makeStubGitPath(): { binDir: string; gitLog: string } {
  const binDir = mkdtempSync(join(tmpdir(), "conductor-help-bin-"));
  const gitLog = join(mkdtempSync(join(tmpdir(), "conductor-help-gitlog-")), "git-calls.log");
  symlinkSync(process.execPath, join(binDir, "node"));
  writeFileSync(
    join(binDir, "git"),
    "#!/bin/sh\necho \"$@\" >> \"" + gitLog + "\"\nexit 0\n",
  );
  chmodSync(join(binDir, "git"), 0o755);
  return { binDir, gitLog };
}

beforeAll(() => {
  if (!existsSync(join(DIST, "check-cli.js"))) {
    throw new Error("dist not built — run `pnpm build` before tests");
  }
});

describe("subcommand help", () => {
  for (const cli of CLIS) {
    // An empty directory with no .intent-guard: a command that actually ran here
    // would either fail the gate, write a skeleton, or both. Help must do
    // neither.
    it(`${cli} --help prints usage, exits 0, and touches nothing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-help-"));
      const res = await run(cli, ["--help"], dir);

      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^Usage: /m);
      expect(readdirSync(dir)).toEqual([]);
    });

    // The empty-temp-dir check above only catches a write into the project
    // directory. It would not catch a shell-out to git (reading branch
    // state, touching global config) that never writes a file there at all.
    // PATH here resolves to only node and a stub git, so any git invocation
    // leaves a line in gitLog; --help must leave that file missing.
    it(`${cli} --help does not shell out to git`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-help-"));
      const { binDir, gitLog } = makeStubGitPath();
      const res = await run(cli, ["--help"], dir, { PATH: binDir });

      expect(res.code).toBe(0);
      expect(existsSync(gitLog)).toBe(false);
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

  it("check --help does not read the contract", async () => {
    // The contract file's usual place is a directory instead. Any code path
    // that opens it as a file (readFileSync, or an fs.readFile that follows
    // the same name) throws EISDIR immediately, so a quiet, exit-0 run here
    // is only possible if --help genuinely never reads it.
    const dir = mkdtempSync(join(tmpdir(), "conductor-help-check-contract-"));
    mkdirSync(join(dir, ".intent-guard"), { recursive: true });
    mkdirSync(join(dir, ".intent-guard", "intent-contract.yaml"));

    const res = await run("check-cli.js", ["--help"], dir);

    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^Usage: /m);
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
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-help-value-"));
    const res = await run("check-cli.js", ["--message", "--help"], dir);
    expect(res.stdout).not.toMatch(/^Usage: /m);
    expect(res.stderr).not.toMatch(/^Usage: /m);
  });

  it("rules audit treats --help after --project as the project value", async () => {
    // Same property as the case above, for the one command that still scanned
    // argv instead of reading its own loop. `--project --help` names a
    // directory called "--help"; that is a real run that should fail to find
    // it, not a help request.
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-help-rules-"));
    const res = await run("rules-cli.js", ["audit", "--project", "--help"], dir);
    expect(res.stdout).not.toMatch(/^Usage: /m);
    expect(res.stderr).not.toMatch(/^Usage: /m);
  });

  it("rules audit still prints help for a bare --help", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-help-rules-bare-"));
    for (const argv of [["--help"], ["audit", "--help"], ["-h"]]) {
      const res = await run("rules-cli.js", argv, dir);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^Usage: intent-guard rules audit/m);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
