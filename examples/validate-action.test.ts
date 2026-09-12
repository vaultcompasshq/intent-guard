// The composite Action, run rather than read.
//
// Nothing type-checks a workflow file, and a broken one fails on somebody
// else's pull request rather than in this repository's suite. So action.yml is
// parsed here and its four bash scripts are executed under the same shell flags
// GitHub uses, with npm and the installed intent-guard binary replaced by
// recorders that capture argv and the directory they were started in.
//
// The reason for running them rather than pattern-matching the YAML: a regular
// expression over a run block agrees with whatever the author wrote. Running
// the block says what intent-guard would actually have been asked to do, and
// from where, which is the only claim worth making about a step that decides
// whether a pull request is allowed to land.
//
// EVERY STEP'S ENVIRONMENT IS DERIVED FROM ITS OWN `env:` MAPPING, never from a
// fixed table in this file. A harness that injects a variable the step does not
// declare tests a program that does not exist: the step would see an empty
// value on a real runner and the suite would still be green. So the keys come
// from action.yml, the values come from the test's input table through the same
// `${{ }}` expressions the runner would expand, and the working directory comes
// from the step's own `working-directory`.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");

interface ActionStep {
  id?: string;
  name?: string;
  shell?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

interface ActionFile {
  name?: string;
  description?: string;
  author?: string;
  branding?: { icon?: string; color?: string };
  inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
  outputs?: Record<string, { value?: string; description?: string }>;
  runs?: { using?: string; steps?: ActionStep[] };
}

// The file under test, overridable so a mutation run can point the whole suite
// at a deliberately weakened copy and watch which assertions go red. Nothing in
// CI sets it, and the default is the real file.
const ACTION_FILE = process.env.IG_ACTION_FILE ?? join(ROOT, "action.yml");

const action = parseYaml(readFileSync(ACTION_FILE, "utf8")) as ActionFile;
const steps = action.runs?.steps ?? [];

/** Each step by id. Not "the step that mentions intent-guard": every one does. */
function step(id: string): ActionStep {
  const found = steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`action.yml has no step with id ${id}`);
  return found;
}

function stepScript(id: string): string {
  return step(id).run ?? "";
}

const validateScript = stepScript("validate");
const installScript = stepScript("install");
const runScript = stepScript("run");
const reportScript = stepScript("report");

/** The step ids whose `run:` blocks this file executes. */
const SCRIPTED_STEPS = ["validate", "install", "run", "report"] as const;

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

// ---------------------------------------------------------------------------
// The runner, as much of it as these scripts can tell apart.
// ---------------------------------------------------------------------------

interface Context {
  inputs: Record<string, string>;
  runnerTemp: string;
  workspace: string;
  stepOutputs: Record<string, Record<string, string>>;
}

/**
 * Expands the `${{ }}` expressions this action uses, and throws on any other.
 *
 * Throwing rather than returning empty is deliberate: a step that starts
 * reading a context this harness does not model would otherwise be tested with
 * that value silently blank, which is the failure this whole file exists to
 * avoid.
 */
function evaluateExpression(template: string, context: Context): string {
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw: string) => {
    const expression = raw.trim();
    if (expression.startsWith("inputs.")) {
      const name = expression.slice("inputs.".length);
      if (!(name in (action.inputs ?? {}))) {
        throw new Error(`action.yml reads inputs.${name}, which it does not declare`);
      }
      return context.inputs[name] ?? "";
    }
    if (expression === "runner.temp") return context.runnerTemp;
    if (expression === "github.workspace") return context.workspace;
    const output = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_]+)$/.exec(expression);
    if (output) return context.stepOutputs[output[1]]?.[output[2]] ?? "";
    throw new Error(`the harness cannot evaluate the expression ${expression}`);
  });
}

/** The step's declared env, with the runner's expansion applied. */
function envForStep(id: string, context: Context): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(step(id).env ?? {})) {
    env[key] = evaluateExpression(String(template), context);
  }
  return env;
}

/**
 * Where the step runs. A composite step with no `working-directory` runs at the
 * workspace root, which is the head's own tree, so the default here has to be
 * the workspace: a harness that defaulted to somewhere safe would report a step
 * as isolated that is not.
 */
function cwdForStep(id: string, context: Context): string {
  const declared = step(id)["working-directory"];
  return declared ? evaluateExpression(declared, context) : context.workspace;
}

function defaultInputs(overrides: Record<string, string> = {}): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(action.inputs ?? {})) {
    inputs[name] = String(spec.default ?? "");
  }
  return { ...inputs, ...overrides };
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

interface StepResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a script the way GitHub runs a composite bash step.
 *
 * The flags matter and are not decoration: GitHub invokes the script as
 * `bash --noprofile --norc -eo pipefail {0}`, so errexit is already on before
 * the first line. A step that expects intent-guard to exit non-zero has to
 * clear errexit itself around that one call, and a test that ran the script
 * under a plain `bash -c` would never notice that it had not.
 */
function execScript(
  script: string,
  options: { cwd: string; env: Record<string, string> },
): StepResult {
  const file = join(tempDir(), "step.sh");
  writeFileSync(file, script, "utf8");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    encoding: "utf8",
    cwd: options.cwd,
    env: options.env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Recorders. One stands in for npm, one for the binary npm installs, and two
// more stand in for the routes this action must no longer take.
// ---------------------------------------------------------------------------

function writeRecorder(path: string, record: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // NUL delimited, so an argument containing a newline can never be read
      // back as two arguments and an injected element cannot hide as one.
      `printf 'cwd\\0%s\\0' "$(pwd -P)" >> ${JSON.stringify(record)}`,
      `for arg in "$@"; do printf 'arg\\0%s\\0' "$arg" >> ${JSON.stringify(record)}; done`,
      `if [ -z "\${IG_TEST_SILENT:-}" ]; then printf '%s\\n' ${JSON.stringify(marker)}; fi`,
      'exit "${IG_TEST_STATUS:-0}"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

interface Recorded {
  ran: boolean;
  argv: string[];
  cwd: string[];
}

function readRecord(file: string): Recorded {
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const fields = raw.split("\0");
  fields.pop();
  const argv: string[] = [];
  const cwd: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "arg") argv.push(fields[i + 1]);
    if (fields[i] === "cwd") cwd.push(fields[i + 1]);
  }
  return { ran: cwd.length > 0, argv, cwd };
}

const GATE_MARKER = "intent-guard recorder stdout";

interface Harness {
  context: Context;
  workspace: string;
  runnerTemp: string;
  pathDir: string;
  outputsFile: string;
  npmRecord: string;
  npxRecord: string;
  plantedRecord: string;
  gateRecord: string;
  gateBin: string;
}

/**
 * A runner with the checkout, the runner temp, and a PATH of its own.
 *
 * The planted files are the attack the install boundary exists to close: a
 * `.npmrc` and a `node_modules/@vaultcompass/intent-guard` committed by the
 * head, both sitting in the workspace where an action that ran from the
 * checkout would find them.
 */
function makeHarness(overrides: Record<string, string> = {}): Harness {
  const dir = tempDir();
  const workspace = join(dir, "workspace");
  const runnerTemp = join(dir, "runner-temp");
  const pathDir = join(dir, "path-bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(pathDir, { recursive: true });

  const context: Context = {
    inputs: defaultInputs(overrides),
    runnerTemp,
    workspace,
    stepOutputs: {},
  };

  const npmRecord = join(dir, "npm-record.bin");
  const npxRecord = join(dir, "npx-record.bin");
  const plantedRecord = join(dir, "planted-record.bin");
  const gateRecord = join(dir, "gate-record.bin");

  writeRecorder(join(pathDir, "npm"), npmRecord, "npm recorder stdout");
  writeRecorder(join(pathDir, "npx"), npxRecord, "npx recorder stdout");

  // The head's own copy, in the place a prior install step would have put it,
  // with node_modules/.bin ahead of nothing: it is reached only by a run step
  // that resolves the gate by name from inside the checkout.
  writeRecorder(
    join(workspace, "node_modules/@vaultcompass/intent-guard/cli.js"),
    plantedRecord,
    "PLANTED node_modules COPY RAN",
  );
  writeRecorder(
    join(workspace, "node_modules/.bin/intent-guard"),
    plantedRecord,
    "PLANTED node_modules COPY RAN",
  );
  // A registry the head chose, on the discard port. Nothing should read it.
  writeFileSync(join(workspace, ".npmrc"), "registry=http://127.0.0.1:9/\n", "utf8");
  writeFileSync(
    join(workspace, "package.json"),
    '{"name":"victim-checkout","version":"0.0.0","private":true}\n',
    "utf8",
  );

  // The binary npm would have installed, at the path action.yml says to call.
  const gateBin = envForStep("run", context).IG_BIN ?? "";
  if (gateBin.startsWith("/")) writeRecorder(gateBin, gateRecord, GATE_MARKER);

  const outputsFile = join(dir, "github-output.txt");
  writeFileSync(outputsFile, "");

  return {
    context,
    workspace,
    runnerTemp,
    pathDir,
    outputsFile,
    npmRecord,
    npxRecord,
    plantedRecord,
    gateRecord,
    gateBin,
  };
}

/**
 * The environment a step gets from the runner, with the head's own
 * `node_modules/.bin` AHEAD of everything else on PATH.
 *
 * That ordering is the hostile case, not a convenience: a workflow that ran its
 * install step before this action has the checkout's `node_modules/.bin` on
 * PATH already, and that directory's contents come from the head's package.json
 * and lockfile. Putting it first is what gives "the planted copy never ran" its
 * meaning. Without it the assertion holds for the uninteresting reason that
 * nothing could have reached the planted copy in the first place, and a run
 * step that resolved the gate by bare name would look isolated while being
 * exactly the thing this boundary exists to stop.
 */
function ambientFor(harness: Harness, event: Record<string, string>): Record<string, string> {
  const headBin = join(harness.workspace, "node_modules/.bin");
  return {
    PATH: `${headBin}${delimiter}${harness.pathDir}${delimiter}${process.env.PATH ?? ""}`,
    GITHUB_WORKSPACE: harness.workspace,
    GITHUB_OUTPUT: harness.outputsFile,
    ...event,
  };
}

function runInstall(
  harness: Harness,
  event: Record<string, string> = PULL_REQUEST_EVENT,
  extra: Record<string, string> = {},
): StepResult {
  return execScript(installScript, {
    cwd: cwdForStep("install", harness.context),
    env: { ...ambientFor(harness, event), ...extra, ...envForStep("install", harness.context) },
  });
}

interface GateRun extends StepResult {
  argv: string[];
  outputs: string;
  harness: Harness;
}

function runGate(
  harness: Harness,
  event: Record<string, string> = PULL_REQUEST_EVENT,
  extra: Record<string, string> = {},
  script: string = runScript,
): GateRun {
  const result = execScript(script, {
    cwd: cwdForStep("run", harness.context),
    env: { ...ambientFor(harness, event), ...extra, ...envForStep("run", harness.context) },
  });
  return {
    ...result,
    argv: readRecord(harness.gateRecord).argv,
    outputs: readFileSync(harness.outputsFile, "utf8"),
    harness,
  };
}

/** The whole action for one set of inputs: validate, install, run. */
function runAction(
  overrides: Record<string, string> = {},
  event: Record<string, string> = PULL_REQUEST_EVENT,
  extra: Record<string, string> = {},
): GateRun {
  const harness = makeHarness(overrides);
  runInstall(harness, event, extra);
  return runGate(harness, event, extra);
}

// Every refusal in this file is asserted on stdout, not stderr. The runner
// parses a `::error::` workflow command on BOTH streams, so this is stricter
// than the runner requires rather than a correctness rule about annotations.
// It is worth keeping anyway: it pins the stream each script actually writes
// to, so a later edit that started sending refusals to stderr would show up
// here as a decision rather than slipping through as a detail.
function runValidate(
  overrides: Record<string, string> = {},
  event: Record<string, string> = PULL_REQUEST_EVENT,
): StepResult {
  const harness = makeHarness(overrides);
  return execScript(validateScript, {
    cwd: cwdForStep("validate", harness.context),
    env: { ...ambientFor(harness, event), ...envForStep("validate", harness.context) },
  });
}

// ---------------------------------------------------------------------------
// Which variables a script reads, as opposed to which ones it was handed.
// ---------------------------------------------------------------------------

/** Provided by the runner itself rather than by a step's `env:` mapping. */
const AMBIENT = new Set([
  "GITHUB_WORKSPACE",
  "GITHUB_OUTPUT",
  "GITHUB_BASE_REF",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_EVENT_NAME",
  "RUNNER_TEMP",
  "PATH",
  "HOME",
  "IFS",
]);

function referencedVariables(script: string): string[] {
  const referenced = new Set<string>();
  for (const match of script.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) referenced.add(match[1]);
  const assigned = new Set<string>();
  for (const match of script.matchAll(/^[ \t]*(?:local[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)) {
    assigned.add(match[1]);
  }
  for (const match of script.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) {
    assigned.add(match[1]);
  }
  for (const match of script.matchAll(/\bread\b[^\n]*-a[ \t]+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assigned.add(match[1]);
  }
  return [...referenced].filter((name) => !assigned.has(name) && !AMBIENT.has(name)).sort();
}

// ---------------------------------------------------------------------------

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

describe("action.yml wires every step to the values it reads", () => {
  it("hands the validate step one variable per declared input", () => {
    // Derived from the file rather than from a table here: an input added
    // without a matching `env:` entry would otherwise be validated against an
    // empty string, which every check in that step accepts.
    const declared = Object.keys(action.inputs ?? {}).sort();
    const wired = Object.values(step("validate").env ?? {})
      .map((template) => /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(String(template))?.[1])
      .filter((name): name is string => Boolean(name))
      .sort();
    expect(wired).toEqual(declared);
  });

  it("declares exactly the variables each script reads, and no others", () => {
    // Both directions matter. A variable read but not declared is empty on a
    // real runner while the harness might still supply it; a variable declared
    // but not read is a value someone believes is in force and is not.
    for (const id of SCRIPTED_STEPS) {
      expect([id, referencedVariables(stepScript(id))]).toEqual([
        id,
        Object.keys(step(id).env ?? {}).sort(),
      ]);
    }
  });

  it("never expands a workflow expression into the script text", () => {
    // An expression expanded inside a run block is pasted in as source text
    // before the shell parses it, so a value carrying a quote rewrites the
    // script. The trust base decides where the rules come from, which makes it
    // the worst possible place for that.
    for (const id of SCRIPTED_STEPS) {
      expect(stepScript(id)).not.toMatch(/\$\{\{/);
    }
  });
});

describe("action.yml installs the gate from outside the tree it judges", () => {
  it("installs the exact pinned version globally, and nothing else", () => {
    const harness = makeHarness();
    const result = runInstall(harness);
    expect(result.status).toBe(0);
    // Exactly this, in this order. An extra specifier, a `--prefix` on the
    // command line, or a spec built from anything but the validated input
    // would all show up here.
    expect(readRecord(harness.npmRecord).argv).toEqual([
      "install",
      "-g",
      "@vaultcompass/intent-guard@1.5.0",
    ]);
  });

  it("declares the runner temp as the working directory for install and run", () => {
    // A composite step with no working-directory runs at the workspace root,
    // which on a pull_request run is the head's own tree. npm started there
    // has the head's .npmrc, package.json and lockfile under its cwd.
    expect(step("install")["working-directory"]).toBe("${{ runner.temp }}");
    expect(step("run")["working-directory"]).toBe("${{ runner.temp }}");
  });

  it("starts npm outside the checkout, so a committed .npmrc is never its cwd", () => {
    const harness = makeHarness();
    runInstall(harness);
    const recorded = readRecord(harness.npmRecord);
    expect(recorded.cwd).toEqual([realpathSync(harness.runnerTemp)]);
    expect(recorded.cwd[0]).not.toContain(realpathSync(harness.workspace));
  });

  it("installs under a prefix in the runner temp, not into the checkout", () => {
    const harness = makeHarness();
    const prefix = envForStep("install", harness.context).npm_config_prefix;
    expect(prefix).toBe(join(harness.runnerTemp, "intent-guard-action"));
    // npm reads this variable itself, so nothing has to pass --prefix on a
    // command line where a hostile value could be read as another argument.
    expect(installScript).toContain("npm_config_prefix");
    // Removed first: the harness pre-plants the installed binary there, and
    // the claim under test is that the step creates the prefix itself rather
    // than relying on npm to.
    rmSync(prefix, { recursive: true, force: true });
    expect(existsSync(prefix)).toBe(false);
    runInstall(harness);
    expect(existsSync(prefix)).toBe(true);
  });
});

describe("action.yml runs the installed binary and nothing else", () => {
  it("calls the gate by absolute path, with an absolute project root", () => {
    // origin/ prefixed, not bare: GITHUB_BASE_REF is a branch NAME, and after
    // actions/checkout only the remote-tracking ref exists locally. A bare
    // "main" resolves to nothing on a detached-HEAD checkout, and intent-guard
    // exits 2 for a reason that has nothing to do with the change.
    //
    // --project absolute because this step runs from the runner temp: a
    // relative root would resolve against that instead of the checkout.
    const run = runAction();
    expect(run.status).toBe(0);
    expect(run.argv).toEqual([
      "check",
      "--project",
      `${run.harness.workspace}/.`,
      "--base",
      "origin/main",
      "--trust-base",
      "origin/main",
    ]);
    expect(run.harness.gateBin).toBe(
      join(run.harness.runnerTemp, "intent-guard-action/bin/intent-guard"),
    );
  });

  it("puts the head's copy somewhere a bare-name resolution would reach it", () => {
    // The negative control for the test below, and the reason it is a test
    // rather than a comment: `plantedRecord.ran === false` is only evidence if
    // something could have run the planted copy. If this ever fails, that
    // assertion has stopped meaning anything and starts passing for the
    // uninteresting reason.
    const harness = makeHarness();
    const reached = spawnSync("intent-guard", ["--version"], {
      encoding: "utf8",
      cwd: harness.runnerTemp,
      env: ambientFor(harness, PULL_REQUEST_EVENT),
    });
    expect(reached.status).toBe(0);
    expect(reached.stdout).toContain("PLANTED");
    expect(readRecord(harness.plantedRecord).ran).toBe(true);
  });

  it("ignores a node_modules copy and an .npmrc the head committed", () => {
    // The two redirects this boundary exists to close. The head controls both:
    // node_modules content comes from its package.json and lockfile, and a
    // committed .npmrc repoints the registry npm fetches from. Proved by what
    // ran, not by reading the script: the planted copy is first on PATH for
    // this run, so the gate reaching the installed binary instead is a fact
    // about the step rather than about the fixture.
    const harness = makeHarness();
    runInstall(harness);
    const run = runGate(harness);
    // The head's copy first, so a step that took the wrong binary fails with a
    // message naming the attack rather than with "expected false to be true"
    // about the recorder that did not get its turn.
    expect(readRecord(harness.plantedRecord).ran).toBe(false);
    expect(readRecord(harness.npxRecord).ran).toBe(false);
    expect(run.status).toBe(0);
    expect(readRecord(harness.gateRecord).ran).toBe(true);
    expect(run.stdout).toContain(GATE_MARKER);
    expect(run.stdout).not.toContain("PLANTED");
    // And it ran from outside the tree, so nothing in the tree was its cwd.
    expect(readRecord(harness.gateRecord).cwd).toEqual([realpathSync(harness.runnerTemp)]);
  });

  it("resolves the gate by neither npx nor the checkout PATH", () => {
    // A text check as well as the behavioural one above: npx would fetch a
    // spec the head's .npmrc can repoint, and a bare name would be resolved
    // against a PATH the workflow may have had node_modules/.bin added to.
    expect(runScript).not.toContain("npx");
    expect(runScript).not.toMatch(/cd\s+"?\$\{?GITHUB_WORKSPACE/);
  });

  it("records intent-guard's own exit code and still exits 0 itself", () => {
    // The report step is what fails the job. This step has to reach its
    // output lines even when the gate blocked, which is the whole case the
    // action exists for.
    const clean = runAction();
    expect(clean.status).toBe(0);
    expect(clean.outputs).toMatch(/exit_code=0/);

    const blocked = runAction({}, PULL_REQUEST_EVENT, { IG_TEST_STATUS: "1" });
    expect(blocked.status).toBe(0);
    expect(blocked.outputs).toMatch(/exit_code=1/);

    const stuck = runAction({}, PULL_REQUEST_EVENT, { IG_TEST_STATUS: "2" });
    expect(stuck.status).toBe(0);
    expect(stuck.outputs).toMatch(/exit_code=2/);
  });

  it("writes JSON to the named file and leaves the argv ending in --json", () => {
    const run = runAction({ "json-output": "out/result.json" });
    expect(run.argv[run.argv.length - 1]).toBe("--json");
    expect(readFileSync(join(run.harness.workspace, "out/result.json"), "utf8")).toContain(
      GATE_MARKER,
    );
    expect(run.outputs).toMatch(/result_file=.*out\/result\.json/);
  });

  it("publishes no result file when the gate died before writing one", () => {
    // Exit 2 in JSON mode leaves the redirect target created and empty. A
    // `result-file` output pointing at an empty file is worse than none: the
    // step reading it parses nothing and reports a parse error instead of the
    // fact that the gate could not run.
    const run = runAction({ "json-output": "out/result.json" }, PULL_REQUEST_EVENT, {
      IG_TEST_STATUS: "2",
      IG_TEST_SILENT: "1",
    });
    expect(run.outputs).toMatch(/exit_code=2/);
    expect(run.outputs).toMatch(/result_file=\n/);
    expect(run.stdout).toMatch(/no JSON/i);
  });

  it("leaves stdout in the job log when no JSON file was asked for", () => {
    const run = runAction();
    expect(run.stdout).toContain(GATE_MARKER);
    expect(run.outputs).toMatch(/result_file=\n/);
  });

  it("passes --no-require-frozen only when the input asked for it", () => {
    expect(runAction().argv).not.toContain("--no-require-frozen");
    expect(runAction({ "require-frozen": "false" }).argv).toContain("--no-require-frozen");
  });

  it("passes explicit paths through as one comma-separated value", () => {
    const run = runAction({ paths: "src/app.ts,docs/readme.md" });
    const index = run.argv.indexOf("--paths");
    expect(index).toBeGreaterThan(-1);
    expect(run.argv[index + 1]).toBe("src/app.ts,docs/readme.md");
  });

  it("lets an explicit trust-base redirect the base ref without disabling it", () => {
    const run = runAction({ "trust-base": "origin/release" });
    const index = run.argv.indexOf("--trust-base");
    expect(run.argv[index + 1]).toBe("origin/release");
  });

  it("warns when a run has no trust base at all", () => {
    // base decides which paths are judged; it never decides where the rules
    // come from. Off a pull request, with no trust-base, the contract and
    // config are read from the tree being judged, which is the thing the
    // pull-request mode exists to prevent. Named events, because merge_group
    // and pull_request_review are where a caller most often lands here by
    // accident.
    const run = runAction({ base: "origin/main" }, PUSH_EVENT);
    expect(run.stdout).toMatch(/::warning::/);
    expect(run.stdout).toMatch(/merge_group/);
    expect(run.stdout).toMatch(/pull_request_review/);
    expect(run.argv).not.toContain("--trust-base");
  });

  it("says nothing of the sort when the event supplied a trust base", () => {
    expect(runAction().stdout).not.toMatch(/::warning::/);
    expect(runAction({ "trust-base": "origin/release" }, PUSH_EVENT).stdout).not.toMatch(
      /::warning::/,
    );
  });
});

describe("action.yml validates its inputs before a shell sees them", () => {
  it("accepts the defaults on a pull request", () => {
    const accepted = runValidate();
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toBe("");
  });

  it("accepts an exact version and refuses everything else", () => {
    // EXACT VERSIONS ONLY. The two families this closes are different: a
    // dist-tag hands the choice of program to the registry on the morning of
    // the run, while a value beginning with a dot or ending in .tgz is read by
    // npm as a PATH, which would let the tree being judged supply its own gate.
    expect(runValidate({ version: "1.5.0" }).status).toBe(0);
    for (const rejected of [".", "..", "payload.tgz", "latest", "next", "beta", "-1.5.0", "1.x"]) {
      const refused = runValidate({ version: rejected });
      expect([rejected, refused.status]).toEqual([rejected, 1]);
      expect(refused.stdout).toMatch(/::error::.*`version`/);
    }
  });

  it("refuses a version carrying a shell metacharacter", () => {
    // The value reaches a package specifier. It arrives through the
    // environment rather than through an expression, so it cannot rewrite the
    // script, but a version is still not a place to accept punctuation.
    const refused = runValidate({ version: "1.4.0;rm" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`version`/);
  });

  it("refuses a project path that climbs out of the workspace", () => {
    const refused = runValidate({ project: "../elsewhere" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`project`/);
    expect(refused.stdout).toMatch(/\.\./);
  });

  it("refuses any value that begins with a dash", () => {
    // Not only the refs. A path beginning with `-` is read as an OPTION by
    // whichever command it reaches, and the message here can name the workflow
    // input that produced it, which git cannot.
    for (const [name, value] of [
      ["project", "-p"],
      ["base", "--upload-pack"],
      ["trust-base", "-x"],
      ["json-output", "-o.json"],
    ] as const) {
      const refused = runValidate({ [name]: value });
      expect([name, refused.status]).toEqual([name, 1]);
      expect(refused.stdout).toMatch(/dash/);
    }
  });

  it("refuses a json-output path under .github/", () => {
    // That directory holds the workflow file and the CODEOWNERS entry that
    // decide how this gate runs and who may change it. A result written there
    // is one upload or commit step away from being inside the protected path.
    const refused = runValidate({ "json-output": ".github/intent.json" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`json-output`/);
    expect(refused.stdout).toMatch(/\.github/);
  });

  it("refuses a paths value whose second line climbs out of the workspace", () => {
    // `read` stops at the first newline, so a two-line value had its first
    // element validated and its second element validated by nothing, and the
    // whole value was then passed to intent-guard.
    const refused = runValidate({ paths: "ok.ts\n../../etc/passwd" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`paths`/);
    expect(refused.stdout).toMatch(/newline/i);
  });

  it("refuses trust-base off by name, in any case, because there is no opt-out", () => {
    // On a same-repository pull_request event the workflow file runs from the
    // pull request's own head, so an opt-out input would be settable by the
    // very pull request whose control inputs it governs. Refused loudly, with
    // the alternative in the message, rather than left to fail the charset
    // check with a message about characters.
    for (const spelling of ["off", "OFF", "Off", "oFf"]) {
      const refused = runValidate({ "trust-base": spelling });
      expect([spelling, refused.status]).toEqual([spelling, 1]);
      expect(refused.stdout).toMatch(/is not supported/);
    }
  });

  it("refuses a require-frozen value outside the closed enum", () => {
    const refused = runValidate({ "require-frozen": "maybe" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/::error::.*`require-frozen`/);
  });

  it("refuses a push run that named neither base nor paths", () => {
    // The gate fails closed on an empty path set, so there is nothing
    // sensible to default to off a pull request: a run with no paths would
    // pass every push for the wrong reason.
    const refused = runValidate({}, PUSH_EVENT);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/`base`/);
    expect(refused.stdout).toMatch(/`paths`/);
  });

  it("accepts a push run that named paths", () => {
    const accepted = runValidate({ paths: "src/app.ts,docs/readme.md" }, PUSH_EVENT);
    expect(accepted.status).toBe(0);
  });
});

describe("action.yml re-raises the real exit code", () => {
  function runReport(code: string, resultFile = ""): StepResult {
    const harness = makeHarness();
    harness.context.stepOutputs.run = { exit_code: code, result_file: resultFile };
    return execScript(reportScript, {
      cwd: cwdForStep("report", harness.context),
      env: { ...ambientFor(harness, PULL_REQUEST_EVENT), ...envForStep("report", harness.context) },
    });
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

  it("points at the JSON result in JSON mode and at the log otherwise", () => {
    // The verdict is not in the run step log in JSON mode: stdout was
    // redirected into the file, so the log holds nothing to read.
    expect(runReport("1").stdout).toMatch(/run step log/);
    expect(runReport("1", "/tmp/result.json").stdout).toMatch(/\/tmp\/result\.json/);
    expect(runReport("1", "/tmp/result.json").stdout).not.toMatch(/run step log/);
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

  it("treats any other code as could not run, never as a verdict", () => {
    // 126 and 127 are the shell's, not intent-guard's: the binary was not
    // found or was not executable, which means the install step failed and
    // nothing judged the change. Anything else is equally not a verdict.
    for (const code of ["126", "127", "3", "255", "not-a-number"]) {
      const other = runReport(code);
      expect([code, other.status]).toEqual([code, 2]);
      expect(other.stdout).toMatch(/::error::/);
      expect(other.stdout).toContain(code);
      expect(other.stdout).toMatch(/did not produce a verdict/i);
      expect(other.stdout).not.toMatch(/blocked/i);
    }
  });

  it("fails on an empty code rather than reading it as a pass", () => {
    // Empty means the run step never got far enough to record anything: an
    // input failed validation, or the step died. That is not a clean run, and
    // it is not a verdict either, so it re-raises 2 like the other could-not-
    // run cases and a required check still fails.
    const missing = runReport("");
    expect(missing.status).toBe(2);
    expect(missing.stdout).toMatch(/::error::.*did not run/i);
    expect(missing.stdout).not.toMatch(/blocked/i);
  });
});
