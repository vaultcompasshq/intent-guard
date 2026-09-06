import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

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
  const binDir = mkdtempSync(join(tmpdir(), "conductor-version-bin-"));
  const gitLog = join(mkdtempSync(join(tmpdir(), "conductor-version-gitlog-")), "git-calls.log");
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

describe("subcommand version", () => {
  for (const cli of CLIS) {
    // An empty directory with no .intent-guard: a command that actually ran
    // here would either fail the gate, write a skeleton, or both. --version
    // must do neither — same property help already has to satisfy.
    it(`${cli} --version prints exactly the package version, exits 0, and touches nothing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-version-"));
      const res = await run(cli, ["--version"], dir);

      expect(res.code).toBe(0);
      expect(res.stdout).toBe(`${PACKAGE_VERSION}\n`);
      expect(res.stderr).toBe("");
      expect(readdirSync(dir)).toEqual([]);
    });

    // The empty-temp-dir check above only catches a write into the project
    // directory. It would not catch a shell-out to git (reading branch
    // state, touching global config) that never writes a file there at all.
    // PATH here resolves to only node and a stub git, so any git invocation
    // leaves a line in gitLog; --version must leave that file missing.
    it(`${cli} --version does not shell out to git`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-version-"));
      const { binDir, gitLog } = makeStubGitPath();
      const res = await run(cli, ["--version"], dir, { PATH: binDir });

      expect(res.code).toBe(0);
      expect(existsSync(gitLog)).toBe(false);
    });

    it(`${cli} -v prints the same version`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conductor-version-"));
      const res = await run(cli, ["-v"], dir);

      expect(res.code).toBe(0);
      expect(res.stdout).toBe(`${PACKAGE_VERSION}\n`);
      expect(res.stderr).toBe("");
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it("takes --version as a flag, not as a flag's value", async () => {
    // `--message --version` means the message is the literal string
    // "--version". That is a real run, so it must not print the version.
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-version-value-"));
    const res = await run("check-cli.js", ["--message", "--version"], dir);
    expect(res.stdout).not.toBe(`${PACKAGE_VERSION}\n`);
  });

  it("rules audit treats --version after --project as the project value", async () => {
    // Same property as the case above, for the one command that still keeps
    // a leading-token check ahead of its loop.
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-version-rules-"));
    const res = await run("rules-cli.js", ["audit", "--project", "--version"], dir);
    expect(res.stdout).not.toBe(`${PACKAGE_VERSION}\n`);
  });

  it("rules audit still prints version for a bare --version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-version-rules-bare-"));
    for (const argv of [["--version"], ["audit", "--version"], ["-v"]]) {
      const res = await run("rules-cli.js", argv, dir);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(`${PACKAGE_VERSION}\n`);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
