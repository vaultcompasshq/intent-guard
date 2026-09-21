/**
 * Outside pull-request mode, nothing changed.
 *
 * The expected values below were recaptured against coverage-threshold
 * matching (strong / partial / none). Fingerprints are the same hashes as
 * the pre-trust-base capture: a fingerprint is a promise to a consumer
 * storing findings. Reasons are matched by prefix downstream, so this file
 * fails if pull-request mode changed a single character of what a
 * pre-commit hook or a plain CLI run sees. It is a regression fence, not a
 * description of desired behaviour.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("node", [join(DIST, "check-cli.js"), ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { code: 0, stdout: String(stdout) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "" };
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

const FROZEN = `contract_id: ic-20260905-parity
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

const DRAFT = FROZEN.replace("frozen_by: user\n", "frozen_by: agent\n").replace(
  /approval:\n(?:  .*\n)+/,
  "",
);

function repo(contract: string | null, changedOnBranch: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-parity-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  if (contract) writeAt(dir, ".intent-guard/intent-contract.yaml", contract);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  for (const relative of changedOnBranch) writeAt(dir, relative, `touched ${relative}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "work"]);
  return dir;
}

const DRIFT_ADVISORY = {
  overall: 0,
  action: "proceed",
  categories: {
    scope_creep: 0,
    constraint_violation: 0,
    ac_divergence: 0,
    undocumented_pivot: 0,
  },
  findings: [
    'possible Out-of-scope touched: "Changes to the payment module" (matched: payment)',
    'possible critical constraint at risk: "Do not touch the payment module" (matched: payment)',
  ],
  finding_details: [
    {
      fingerprint: "8b626394b1a5ca648f51a8a8565e22cf67644b6d1d857fd117c1be5e7070fe6b",
      category: "scope_creep",
      rule_id: "scope_creep:Changes to the payment module",
      message:
        'possible Out-of-scope touched: "Changes to the payment module" (matched: payment)',
      matched: ["payment"],
      strength: "partial",
    },
    {
      fingerprint: "e7802d529e492fd649f7fbbbbeb2b7513cfefbaa2b614219a494137d485e7f4a",
      category: "constraint_violation",
      rule_id: "constraint_violation:Do not touch the payment module",
      message:
        'possible critical constraint at risk: "Do not touch the payment module" (matched: payment)',
      matched: ["payment"],
      strength: "partial",
    },
  ],
};

const PROTECTED_BUDGET = {
  ok: false,
  action: "hard_block",
  violations: [
    {
      fingerprint: "33c95db46bf9d51c1832aaf033dc5edf71a3001a5ab2f046da4c90d49a58b320",
      rule: "protected_paths",
      severity: "hard_block",
      message: "Touched protected path(s): src/payment/charge.ts",
      matched: ["src/payment/charge.ts"],
    },
  ],
};

const CLEAN_DRIFT = {
  overall: 0,
  action: "proceed",
  categories: {
    scope_creep: 0,
    constraint_violation: 0,
    ac_divergence: 0,
    undocumented_pivot: 0,
  },
  findings: [],
  finding_details: [],
};

const BLOCKED_REASONS = [
  "Budget hard_block: Touched protected path(s): src/payment/charge.ts",
];

describe("no-flag gate output is byte-identical to the release before --trust-base", () => {
  it("blocks a protected path collected with --base", async () => {
    const dir = repo(FROZEN, ["src/payment/charge.ts"]);
    const res = await run(["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "blocked",
      exitCode: 1,
      reasons: BLOCKED_REASONS,
      contractFound: true,
      contractFrozen: true,
      drift: DRIFT_ADVISORY,
      budget: PROTECTED_BUDGET,
      crossSessionDrift: null,
    });
  });

  it("passes an allowed path collected with --base", async () => {
    const dir = repo(FROZEN, ["docs/usage.md"]);
    const res = await run(["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "ok",
      exitCode: 0,
      reasons: [],
      contractFound: true,
      contractFrozen: true,
      drift: CLEAN_DRIFT,
      budget: { ok: true, action: "ok", violations: [] },
      crossSessionDrift: null,
    });
  });

  it("blocks with the same no-contract reason and the same absent keys", async () => {
    const dir = repo(null, ["docs/usage.md"]);
    const res = await run(["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "blocked",
      exitCode: 1,
      reasons: [
        "No .intent-guard/intent-contract.yaml found. Draft intent with intent-guard-extract, then approve with intent-guard-freeze before implementing.",
      ],
      contractFound: false,
      contractFrozen: false,
      crossSessionDrift: null,
    });
  });

  it("blocks an unfrozen contract with the same reason", async () => {
    const dir = repo(DRAFT, ["docs/usage.md"]);
    const res = await run(["--project", dir, "--base", "main", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "blocked",
      exitCode: 1,
      reasons: [
        "Intent contract exists but is not frozen by user. Approve and freeze before implementing.",
      ],
      contractFound: true,
      contractFrozen: false,
      drift: CLEAN_DRIFT,
      budget: { ok: true, action: "ok", violations: [] },
      crossSessionDrift: null,
    });
  });

  it("scores drift on explicit --paths exactly as before", async () => {
    const dir = repo(FROZEN, ["docs/usage.md"]);
    const res = await run([
      "--project", dir,
      "--paths", "src/payment/charge.ts",
      "--json",
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "blocked",
      exitCode: 1,
      reasons: BLOCKED_REASONS,
      contractFound: true,
      contractFrozen: true,
      drift: DRIFT_ADVISORY,
      budget: PROTECTED_BUDGET,
      crossSessionDrift: null,
    });
  });

  it("passes a missing contract under --no-require-frozen exactly as before", async () => {
    const dir = repo(null, ["docs/usage.md"]);
    const res = await run([
      "--project", dir,
      "--base", "main",
      "--no-require-frozen",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      status: "ok",
      exitCode: 0,
      reasons: [],
      contractFound: false,
      contractFrozen: false,
      crossSessionDrift: null,
    });
  });
});
