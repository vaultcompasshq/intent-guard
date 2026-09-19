import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-empty-list-flag-"));
}

/** A frozen contract, so drift has something to score. */
const CONTRACT = `contract_id: ic-20260918-aaaaaa
version: 1.0.0
original_ask: Update the readme usage docs and nothing else.
in_scope:
  - Update the README usage documentation
out_of_scope:
  - Changes to the payment module
constraints:
  - source: user-stated
    rule: Do not touch the payment module
    priority: critical
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-18T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-18T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  protected_paths:
    - "**/payment/**"
`;

/** A project directory with a contract file on disk, and the path to it. */
function projectWithContract(): { dir: string; contract: string } {
  const dir = tmpProject();
  const contract = join(dir, "contract.yaml");
  writeFileSync(contract, CONTRACT, "utf8");
  return { dir, contract };
}

beforeAll(() => {
  if (!existsSync(join(DIST, "check-cli.js"))) {
    throw new Error("dist not built - run `pnpm build` before tests");
  }
});

// AN EMPTY LIST IS A VALUE. A MISSING LIST IS NOT.
//
// 1.5.1 made every CLI refuse a known value flag that arrived without its
// value, and tested the value with a truthiness check. An explicit empty
// string is falsy, so `--paths ""` fell out of its own arm and was answered
// `option '--paths' requires a value` plus the whole usage screen, exit 1, no
// report.
//
// That is the shape the umbrella runner sends. It builds the pull-request path
// list from a diff against the base and passes `--paths ""` when the diff is
// empty, so that the empty set is STATED rather than left for the gate to
// guess at. On 1.5.1 that run produced usage text and no JSON, the umbrella
// read it as could-not-run, and the pull request went red for a change that
// had touched nothing the gate cared about. 1.5.0 dropped both tokens
// silently, so the same command worked by accident.
//
// The two cases are different and both have to be answered. An empty string
// after the flag is the empty list. Nothing after the flag, or another flag
// after it, is the missing value 1.5.1 set out to catch.
describe("an empty list flag means the empty list", { timeout: 60_000 }, () => {
  it("check accepts --paths with an empty value and still reports", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--paths", "", "--json"]);

    expect(res.stderr).not.toContain("error: option");
    expect(res.stderr).not.toMatch(/^Usage: /m);
    // No contract in a bare directory, so the gate blocks. The point is that it
    // ran at all and answered in JSON.
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).status).toBe("blocked");
  });

  it("check accepts --signals with an empty value", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--signals", "", "--json"]);

    expect(res.stderr).not.toContain("error: option");
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).status).toBe("blocked");
  });

  it("report accepts --paths and --signals with empty values", async () => {
    const dir = tmpProject();
    const res = await run("report-cli.js", [
      "--project",
      dir,
      "--paths",
      "",
      "--signals",
      "",
      "--json",
    ]);

    expect(res.stderr).not.toContain("error: option");
    expect(res.stderr).not.toMatch(/^Usage: /m);
    expect(JSON.parse(res.stdout).exitCode).toBeDefined();
  });

  it("drift accepts --paths and --signals with empty values", async () => {
    const { dir, contract } = projectWithContract();
    const res = await run("drift-cli.js", [
      "--project",
      dir,
      "--contract",
      contract,
      "--paths",
      "",
      "--signals",
      "",
    ]);

    expect(res.stderr).not.toContain("error: option");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).action).toBeDefined();
  });

  // THE DIRECT MEASUREMENT. Everything above shows the command ran; this shows
  // WHAT it ran with. The report carries the path list it judged, so an empty
  // string has to arrive as zero entries rather than as one empty entry, and
  // the second half of the pair proves the field is not simply always empty.
  it("check reports zero changed paths for --paths with an empty value", async () => {
    const dir = tmpProject();

    const empty = await run("report-cli.js", ["--project", dir, "--paths", "", "--json"]);
    expect(JSON.parse(empty.stdout).changed_paths).toEqual([]);

    const named = await run("report-cli.js", [
      "--project",
      dir,
      "--paths",
      "src/a.ts,src/b.ts",
      "--json",
    ]);
    expect(JSON.parse(named.stdout).changed_paths).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// The refusal 1.5.1 wanted, kept. A list flag with nothing after it is still a
// mistake, and so is a list flag followed by the next flag: the old truthiness
// arm ACCEPTED that one and swallowed the following flag as the path list, so
// `--paths --json` ran the gate against a path literally named "--json" and
// printed human output because --json was never seen.
describe("a list flag with no value of its own is still refused", { timeout: 60_000 }, () => {
  it("check --paths as the last argument names the value", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--paths"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    expect(res.stderr).not.toContain("unknown option");
  });

  it("check --paths --json does not swallow --json", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--paths", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    // The tell that --json was not consumed as the path list: the gate never
    // ran, so there is no verdict on stdout at all.
    expect(res.stdout).toBe("");
  });

  it("check --signals --json does not swallow --json", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--signals", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--signals' requires a value");
    expect(res.stdout).toBe("");
  });

  it("report --paths as the last argument names the value", async () => {
    const dir = tmpProject();
    const res = await run("report-cli.js", ["--project", dir, "--paths"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    expect(res.stderr).not.toContain("unknown option");
  });

  it("report --paths --json does not swallow --json", async () => {
    const dir = tmpProject();
    const res = await run("report-cli.js", ["--project", dir, "--paths", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    expect(res.stdout).toBe("");
  });

  it("report --signals as the last argument names the value", async () => {
    const dir = tmpProject();
    const res = await run("report-cli.js", ["--project", dir, "--signals"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--signals' requires a value");
  });

  it("drift --paths as the last argument names the value", async () => {
    const { dir, contract } = projectWithContract();
    const res = await run("drift-cli.js", ["--project", dir, "--contract", contract, "--paths"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    expect(res.stderr).not.toContain("unknown option");
  });

  it("drift --paths --log does not swallow --log", async () => {
    const { dir, contract } = projectWithContract();
    const res = await run("drift-cli.js", [
      "--project",
      dir,
      "--contract",
      contract,
      "--paths",
      "--log",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--paths' requires a value");
    expect(res.stdout).toBe("");
  });

  it("drift --signals as the last argument names the value", async () => {
    const { dir, contract } = projectWithContract();
    const res = await run("drift-cli.js", ["--project", dir, "--contract", contract, "--signals"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--signals' requires a value");
  });
});

// Scalar flags are unchanged. An empty string is a value for a list and a
// missing value for a scalar, because there is no such thing as an empty
// project root or an empty contract id, and 1.5.1 refusing those is correct.
describe("scalar value flags still refuse an empty string", { timeout: 60_000 }, () => {
  it("check --project with an empty value is still a missing value", async () => {
    const res = await run("check-cli.js", ["--project", ""]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--project' requires a value");
  });

  it("check --message with an empty value is still a missing value", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--message", ""]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--message' requires a value");
  });

  it("check --previous-contract with an empty value is still a missing value", async () => {
    const dir = tmpProject();
    const res = await run("check-cli.js", ["--project", dir, "--previous-contract", ""]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--previous-contract' requires a value");
  });

  it("drift --contract with an empty value is still a missing value", async () => {
    const dir = tmpProject();
    const res = await run("drift-cli.js", ["--project", dir, "--contract", ""]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("option '--contract' requires a value");
  });
});
