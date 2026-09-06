import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/**
 * The approved contract on the base branch. Narrow on purpose: one in-scope
 * item, one out-of-scope item that a path can trip, one critical constraint,
 * and a protected path. Every attack below is an attempt to widen one of them
 * from inside the pull request.
 */
const BASE_CONTRACT = `contract_id: ic-20260905-aaaaaa
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
frozen_at: "2026-09-05T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  protected_paths:
    - "**/payment/**"
`;

/** The forgery: wide open, self-approved, protected paths gone. */
const FORGED_CONTRACT = `contract_id: ic-20260905-aaaaaa
version: 1.0.0
original_ask: Refactor the payment module and update the docs.
in_scope:
  - Update the README usage documentation
  - Refactor the payment module end to end
out_of_scope: []
constraints: []
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-06T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: the-pull-request-itself
  approved_at: "2026-09-06T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  allowed_paths:
    - "**"
`;

/**
 * The same widening WITHOUT touching the approval block. This is the honest
 * case: somebody proposes a broader contract and has not re-frozen it.
 */
const WIDENED_CONTRACT = FORGED_CONTRACT.replace(
  /approval:\n(?:  .*\n)+/,
  `approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
`,
);

/**
 * A contract whose only lever is a MEDIUM-priority constraint.
 *
 * The config attack needs a drift signal with no score floor under it. A
 * scope-creep hit and a high or critical constraint each floor the overall
 * score at a band taken from the config itself, so raising that band raises
 * the score with it and the gate blocks anyway. A medium constraint has no
 * floor, so its weighted score of 12 is entirely at the mercy of where the
 * bands sit. That is the config lever that is real, and it is the one these
 * tests use.
 */
const MEDIUM_CONSTRAINT_CONTRACT = `contract_id: ic-20260905-bbbbbb
version: 1.0.0
original_ask: Update the readme usage docs and nothing else.
in_scope:
  - Update the README usage documentation
out_of_scope: []
constraints:
  - source: user-stated
    rule: Do not touch the payment module
    priority: medium
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-05T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
`;

/** The project's own strict bands, committed on the base branch. */
const STRICT_BASE_CONFIG = `version: 1.0.0
drift:
  mode: handoff
  thresholds:
    info: 1
    warn: 2
    soft_block: 3
    hard_block: 4
  hard_block_on_critical_constraints: true
`;

/**
 * The bands relaxed back to the shipped defaults. Every value is legal, which
 * is exactly why the base-versus-head rule and not a schema floor is what
 * catches this one.
 */
const RELAXED_HEAD_CONFIG = `version: 1.0.0
drift:
  mode: handoff
  thresholds:
    info: 26
    warn: 51
    soft_block: 71
    hard_block: 86
  hard_block_on_critical_constraints: false
`;

interface RepoSpec {
  /** Files committed on main before the branch forks. */
  base: Record<string, string>;
  /** Files written and committed on the feature branch. */
  head: Record<string, string>;
}

function repo(spec: RepoSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-trust-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  for (const [relative, body] of Object.entries(spec.base)) writeAt(dir, relative, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  for (const [relative, body] of Object.entries(spec.head)) writeAt(dir, relative, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "work"]);
  return dir;
}

const CONTRACT = ".intent-guard/intent-contract.yaml";
const CONFIG = ".intent-guard/config.yaml";
const OUT_OF_SCOPE_FILE = "src/payment/charge.ts";

describe("intent-guard check --trust-base", { timeout: 60_000 }, () => {
  it("refuses a contract rewrite that grants itself a new approval", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("blocked");
    expect(out.trustBase.selfApproval).toBe(true);
    const selfApproval = (out.reasons as string[]).filter((reason) =>
      reason.startsWith("Self-approval refused:"),
    );
    expect(selfApproval).toHaveLength(1);
    expect(selfApproval[0]).toContain("main");
    // The head contract deleted protected_paths. The base contract still has
    // it, and the base contract is what judged this change.
    expect(JSON.stringify(out.budget)).toContain(OUT_OF_SCOPE_FILE);
    expect(out.budget.action).toBe("hard_block");
  });

  it("names the contract change as a proposal rather than obeying it", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractChanged).toBe(true);
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("ignores a head-side config that relaxes the drift bands, and says so", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    // The base bands hard-block at 4 and the change scores 12. The head bands
    // would have called the same 12 "proceed".
    expect(JSON.parse(res.stdout).drift.action).toBe("hard_block");
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.configChanged).toBe(true);
    expect(out.trustBase.proposals).toContain("config changed in this pull request");
  });

  it("obeys the relaxed head config when the flag is absent, which is the hole", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);

    // Not a wish: this asserts the pre-1.4.0 behaviour is still what a
    // trusted local checkout gets, so the fixtures above are known to be
    // discriminating rather than passing for some other reason.
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).drift.action).toBe("proceed");
  });

  it("reports a widened contract as a proposal and judges against the base scope", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
    // The approval block is untouched, so this is a proposal and not a forgery.
    expect(out.trustBase.selfApproval).toBe(false);
    expect(out.reasons.join(" ")).not.toContain("Self-approval refused");
    // Judged against the base contract, so the widening does not take effect.
    expect(out.drift.findings.join(" ")).toContain("Changes to the payment module");
  });

  it("passes a widening whose changes stay inside the base scope", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("does not raise self-approval when the gate is not enforcing a frozen contract", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--no-require-frozen",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.selfApproval).toBe(false);
    expect(out.reasons.join(" ")).not.toContain("Self-approval refused");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("judges normally and proposes nothing when no control input changed", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.proposals).toEqual([]);
    expect(out.trustBase.contractChanged).toBe(false);
    expect(out.trustBase.configChanged).toBe(false);
  });

  it("reports no contract when the base has none, and treats the head's as a proposal", async () => {
    const dir = repo({
      base: {},
      head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.contractFound).toBe(false);
    expect(out.reasons[0]).toContain("No .intent-guard/intent-contract.yaml found");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
    // First adoption is not an attack, so it is not named as self-approval.
    expect(out.trustBase.selfApproval).toBe(false);
  });

  it("fails closed with exit 2 when the trust base ref cannot be resolved", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--trust-base", "no-such-ref",
      "--paths", "docs/usage.md",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no-such-ref");
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("fails closed with exit 2 on a base config the schema refuses", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT, [CONFIG]: "drift:\n  thresholds:\n    warn: 900\n" },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("main:.intent-guard/config.yaml");
  });

  it("treats --trust-base with no ref value as a usage error", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });
    const res = await run("check-cli.js", ["--project", dir, "--trust-base"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Usage: intent-guard check");
  });

  it("prints the proposal on a human-readable run too", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
    ]);

    expect(res.code).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("contract changed in this pull request");
  });
});

describe("intent-guard report --trust-base", { timeout: 60_000 }, () => {
  it("summarises the base contract, not the head's", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.contract.approved_by).toBe("alice");
    expect(out.contract.out_of_scope).toContain("Changes to the payment module");
    expect(out.gate.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("prints the proposal in the markdown report", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
    ]);

    expect(res.stdout).toContain("config changed in this pull request");
    expect(res.stdout).toContain("Pull-request mode");
  });

  it("fails closed with exit 2 when the trust base ref cannot be resolved", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--trust-base", "ghost-branch",
      "--paths", "docs/usage.md",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("ghost-branch");
  });
});

describe("intent-guard drift --trust-base", { timeout: 60_000 }, () => {
  it("scores with the base ref's thresholds, not the head's", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const withTrust = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--trust-base", "main",
      "--paths", OUT_OF_SCOPE_FILE,
    ]);
    expect(JSON.parse(withTrust.stdout).action).toBe("hard_block");

    const withoutTrust = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--paths", OUT_OF_SCOPE_FILE,
    ]);
    expect(JSON.parse(withoutTrust.stdout).action).toBe("proceed");
  });
});
