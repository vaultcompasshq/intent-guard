// The composite Action, run rather than read.
//
// Nothing type-checks a workflow file, and a broken one fails on somebody
// else's pull request rather than in this repository's suite. So action.yml is
// parsed here and its three bash scripts are executed under the same shell
// flags GitHub uses, with npx replaced by a recorder that captures argv.
//
// The reason for running them rather than pattern-matching the YAML: a regular
// expression over a run block agrees with whatever the author wrote. Running
// the block says what intent-guard would actually have been asked to do, which
// is the only claim worth making about a step that decides whether a pull
// request is allowed to land.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");

interface ActionFile {
  name?: string;
  description?: string;
  author?: string;
  branding?: { icon?: string; color?: string };
  inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
  outputs?: Record<string, { value?: string; description?: string }>;
  runs?: {
    using?: string;
    steps?: Array<{
      id?: string;
      name?: string;
      shell?: string;
      run?: string;
      uses?: string;
      env?: Record<string, string>;
    }>;
  };
}

const action = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")) as ActionFile;
const steps = action.runs?.steps ?? [];

// Each step's own script, by id. Not "the step that mentions intent-guard":
// every step does, so a search like that returns whichever one comes first and
// proves nothing about the one under test.
function stepScript(id: string): string {
  return steps.find((step) => step.id === id)?.run ?? "";
}

const validateScript = stepScript("validate");
const runScript = stepScript("run");
const reportScript = stepScript("report");

const temps: string[] = [];

afterAll(() => {
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-action-"));
  temps.push(dir);
  return dir;
}

/**
 * Runs one step's script the way GitHub runs a composite bash step.
 *
 * The flags matter and are not decoration: GitHub invokes the script as
 * `bash --noprofile --norc -eo pipefail {0}`, so errexit is already on before
 * the first line. A step that expects intent-guard to exit non-zero has to
 * clear errexit itself around that one call, and a test that ran the script
 * under a plain `bash -c` would never notice that it had not.
 */
function runStep(script: string, env: Record<string, string>) {
  const file = join(tempDir(), "step.sh");
  writeFileSync(file, script, "utf8");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const INPUT_VARS: Record<string, string> = {
  version: "IG_VERSION",
  project: "IG_PROJECT",
  base: "IG_BASE",
  paths: "IG_PATHS",
  "trust-base": "IG_TRUST_BASE",
  "require-frozen": "IG_REQUIRE_FROZEN",
  "json-output": "IG_JSON_OUTPUT",
};

/** Every input at its declared default, as the shell would see it. */
function defaultInputEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [input, variable] of Object.entries(INPUT_VARS)) {
    env[variable] = String(action.inputs?.[input]?.default ?? "");
  }
  return { ...env, ...overrides };
}

/** A pull_request event, as GitHub describes one to the step. */
const PULL_REQUEST_EVENT = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_BASE_REF: "main",
};

/** A push event: GITHUB_BASE_REF is defined and empty, which is the trap. */
const PUSH_EVENT = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_BASE_REF: "",
};

// Every refusal in this file is asserted on stdout, not stderr, and that is
// the point rather than an accident: Actions parses a `::error::` workflow
// command out of a step's STDOUT. The same message on stderr still reaches the
// raw log but produces no annotation on the run, so a check that accepted
// either stream would pass for an action whose errors are invisible where
// people read them.
function runValidate(overrides: Record<string, string> = {}) {
  return runStep(validateScript, { ...PULL_REQUEST_EVENT, ...defaultInputEnv(overrides) });
}

interface CheckRun {
  argv: string[];
  status: number | null;
  stdout: string;
  outputs: string;
  workspace: string;
}

/**
 * Runs the run step with npx replaced by a recorder.
 *
 * The recorder writes its argument vector one line per argument, prints a
 * marker on stdout so a redirect can be proved to have caught it, and exits
 * with whatever IG_TEST_STATUS asks for, so the non-zero paths are reachable.
 */
function runCheck(overrides: Record<string, string> = {}, event = PULL_REQUEST_EVENT): CheckRun {
  const dir = tempDir();
  const bin = join(dir, "bin");
  const workspace = join(dir, "workspace");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const record = join(dir, "npx-argv.txt");
  const outputs = join(dir, "github-output.txt");
  writeFileSync(record, "");
  writeFileSync(outputs, "");

  const shim = join(bin, "npx");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(record)}; done`,
      "printf '%s\\n' 'intent-guard recorder stdout'",
      'exit "${IG_TEST_STATUS:-0}"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);

  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", writeScript(dir, runScript)],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: outputs,
        ...event,
        ...defaultInputEnv(overrides),
      },
    },
  );

  return {
    argv: readFileSync(record, "utf8").split("\n").filter((line) => line.length > 0),
    status: result.status,
    stdout: result.stdout ?? "",
    outputs: readFileSync(outputs, "utf8"),
    workspace,
  };
}

function writeScript(dir: string, script: string): string {
  const file = join(dir, "step.sh");
  writeFileSync(file, script, "utf8");
  return file;
}

describe("action.yml metadata", () => {
  it("carries the Marketplace fields the listing requires", () => {
    // Marketplace rejects a listing whose name collides with an existing one,
    // and truncates a description past 125 characters in the search result,
    // which is where most people read it.
    expect(action.name).toBe("Intent Guard");
    expect(action.author).toBe("Vault & Compass LLC");
    expect(String(action.description ?? "").length).toBeLessThan(125);
    expect(action.branding?.icon).toBe("shield");
    expect(action.branding?.color).toBe("purple");
    expect(action.runs?.using).toBe("composite");
  });
});

describe("action.yml validates its inputs before a shell sees them", () => {
  it("accepts the defaults on a pull request", () => {
    const accepted = runValidate();
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toBe("");
  });

  it("refuses a version carrying a shell metacharacter", () => {
    // The value reaches a package specifier. It arrives through the
    // environment rather than through an expression, so it cannot rewrite the
    // script, but a version is still not a place to accept punctuation.
    const refused = runValidate({ IG_VERSION: "1.4.0;rm" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`version`/);
  });

  it("refuses a project path that climbs out of the workspace", () => {
    const refused = runValidate({ IG_PROJECT: "../elsewhere" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`project`/);
    expect(refused.stdout).toMatch(/\.\./);
  });

  it("refuses trust-base off by name, because there is no opt-out", () => {
    // On a same-repository pull_request event the workflow file runs from the
    // pull request's own head, so an opt-out input would be settable by the
    // very pull request whose control inputs it governs. Refused loudly, with
    // the alternative in the message, rather than left to fail the charset
    // check with a message about characters.
    const refused = runValidate({ IG_TRUST_BASE: "off" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/`trust-base: off` is not supported/);
  });

  it("refuses a require-frozen value outside the closed enum", () => {
    const refused = runValidate({ IG_REQUIRE_FROZEN: "maybe" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`require-frozen`/);
  });

  it("refuses a push run that named neither base nor paths", () => {
    // The gate fails closed on an empty path set, so there is nothing
    // sensible to default to off a pull request: a run with no paths would
    // pass every push for the wrong reason.
    const refused = runStep(validateScript, { ...PUSH_EVENT, ...defaultInputEnv() });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/`base`/);
    expect(refused.stdout).toMatch(/`paths`/);
  });

  it("accepts a push run that named paths", () => {
    const accepted = runStep(validateScript, {
      ...PUSH_EVENT,
      ...defaultInputEnv({ IG_PATHS: "src/app.ts,docs/readme.md" }),
    });
    expect(accepted.status).toBe(0);
  });
});

describe("action.yml builds the check command line", () => {
  it("passes the base branch as both the diff base and the trust base", () => {
    // origin/ prefixed, not bare: GITHUB_BASE_REF is a branch NAME, and after
    // actions/checkout only the remote-tracking ref exists locally. A bare
    // "main" resolves to nothing on a detached-HEAD checkout, and intent-guard
    // exits 2 for a reason that has nothing to do with the change.
    const { argv, status } = runCheck();
    expect(status).toBe(0);
    expect(argv).toEqual([
      "--yes",
      "@vaultcompass/intent-guard@1.4.0",
      "check",
      "--project",
      ".",
      "--base",
      "origin/main",
      "--trust-base",
      "origin/main",
    ]);
  });

  it("records intent-guard's own exit code and still exits 0 itself", () => {
    // The report step is what fails the job. This step has to reach its
    // output lines even when the gate blocked, which is the whole case the
    // action exists for.
    const clean = runCheck();
    expect(clean.status).toBe(0);
    expect(clean.outputs).toMatch(/exit_code=0/);

    const blocked = runCheck({ IG_TEST_STATUS: "1" });
    expect(blocked.status).toBe(0);
    expect(blocked.outputs).toMatch(/exit_code=1/);

    const stuck = runCheck({ IG_TEST_STATUS: "2" });
    expect(stuck.status).toBe(0);
    expect(stuck.outputs).toMatch(/exit_code=2/);
  });

  it("writes JSON to the named file and leaves the argv ending in --json", () => {
    const { argv, outputs, workspace } = runCheck({ IG_JSON_OUTPUT: "out/result.json" });
    expect(argv[argv.length - 1]).toBe("--json");
    expect(readFileSync(join(workspace, "out/result.json"), "utf8")).toContain(
      "intent-guard recorder stdout",
    );
    expect(outputs).toMatch(/result_file=.*out\/result\.json/);
  });

  it("leaves stdout in the job log when no JSON file was asked for", () => {
    const { stdout, outputs } = runCheck();
    expect(stdout).toContain("intent-guard recorder stdout");
    expect(outputs).toMatch(/result_file=\n/);
  });

  it("passes --no-require-frozen only when the input asked for it", () => {
    expect(runCheck().argv).not.toContain("--no-require-frozen");
    expect(runCheck({ IG_REQUIRE_FROZEN: "false" }).argv).toContain("--no-require-frozen");
  });

  it("passes explicit paths through as one comma-separated value", () => {
    const { argv } = runCheck({ IG_PATHS: "src/app.ts,docs/readme.md" });
    const index = argv.indexOf("--paths");
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe("src/app.ts,docs/readme.md");
  });

  it("lets an explicit trust-base redirect the base ref without disabling it", () => {
    const { argv } = runCheck({ IG_TRUST_BASE: "origin/release" });
    expect(argv).toContain("origin/release");
    const index = argv.indexOf("--trust-base");
    expect(argv[index + 1]).toBe("origin/release");
  });

  it("never expands a workflow expression into the script text", () => {
    // An expression expanded inside a run block is pasted in as source text
    // before the shell parses it, so a value carrying a quote rewrites the
    // script. The trust base decides where the rules come from, which makes it
    // the worst possible place for that.
    for (const script of [validateScript, runScript, reportScript]) {
      expect(script).not.toMatch(/\$\{\{/);
    }
    for (const variable of Object.values(INPUT_VARS)) {
      expect(Object.keys(steps.find((step) => step.id === "validate")?.env ?? {})).toContain(
        variable,
      );
    }
  });
});

describe("action.yml re-raises the real exit code", () => {
  function runReport(code: string) {
    return runStep(reportScript, { IG_EXIT_CODE: code });
  }

  it("passes a clean run through", () => {
    const clean = runReport("0");
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/ok|no blocking/i);
  });

  it("fails 1 with the blocked message", () => {
    const blocked = runReport("1");
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toMatch(/::error::.*blocked/i);
  });

  it("fails 2 with the could-not-run message, never as a verdict", () => {
    // 2 means intent-guard could not judge the change at all: an unresolvable
    // ref, a missing merge base, a trust base that will not resolve. Reporting
    // it as 1 would tell a caller the change was blocked, which is a different
    // fact.
    const stuck = runReport("2");
    expect(stuck.status).toBe(2);
    expect(stuck.stdout).toMatch(/::error::.*could not/i);
    expect(stuck.stdout).not.toMatch(/blocked/i);
  });

  it("fails on an empty code rather than reading it as a pass", () => {
    // Empty means the run step never got far enough to record anything: an
    // input failed validation, or the step died. That is not a clean run.
    const missing = runReport("");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/::error::.*did not run/i);
  });
});
