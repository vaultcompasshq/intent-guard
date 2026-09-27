import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initConductor } from "../src/init.js";
import { freezeContract, writeContract } from "../src/contract-store.js";
import { checkGate } from "../src/gate.js";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";

/**
 * Freezes a contract with no budget, then appends a raw budget block to the
 * yaml file directly, bypassing writeContract's own schema check -- the way
 * a human hand-editing the file after freezing would. This is the only way
 * to get an already-frozen contract that carries a budget entry invalid
 * enough for the schema pattern to refuse it too (freezeContract, and
 * writeContract's schema check, both now catch this on the way in; see
 * freeze-budget-paths.test.ts). It is also how a contract frozen before this
 * validator existed would look today.
 */
function setupHandFrozenWithInvalidBudget(budgetYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-gate-budget-invalid-"));
  initConductor(dir);
  const frozen = freezeContract(draftContract(undefined), {
    approvedBy: "tester",
    method: "explicit-flag",
  });
  const path = writeContract(dir, frozen);
  writeFileSync(path, `${readFileSync(path, "utf8")}${budgetYaml}`, "utf8");
  return dir;
}

function draftContract(budget: IntentContract["budget"]): IntentContract {
  return {
    contract_id: "ic-20260728-c4d5e6",
    version: "1.0.0",
    original_ask: "Add bounded retry logic to the payments client.",
    in_scope: ["Retry with backoff in the payments client"],
    out_of_scope: ["Changes to unrelated clients"],
    constraints: [],
    acceptance_criteria: [
      { id: "ac-1", description: "Retries stop after the cap", testable: true },
    ],
    frozen_at: "2026-07-28T10:00:00Z",
    pivot_log: [],
    budget,
  };
}

function setup(budget: IntentContract["budget"]): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-gate-budget-"));
  initConductor(dir);
  const frozen = freezeContract(draftContract(budget), {
    approvedBy: "tester",
    method: "explicit-flag",
  });
  writeContract(dir, frozen);
  return dir;
}

describe("checkGate change budget", () => {
  it("blocks with exit 1 when a protected path is touched", () => {
    const dir = setup({ protected_paths: ["**/legacy/**"] });
    const result = checkGate(dir, {
      signals: { changedPaths: ["src/legacy/error-format.ts"] },
    });
    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.budget?.action).toBe("hard_block");
    expect(result.reasons.some((r) => /Budget hard_block/.test(r))).toBe(true);
  });

  it("passes when changes stay within the budget", () => {
    const dir = setup({ allowed_paths: ["src/payments/**"], max_files: 5 });
    const result = checkGate(dir, {
      signals: { changedPaths: ["src/payments/retry.ts"] },
    });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.budget?.ok).toBe(true);
  });

  it("does not evaluate a budget when the contract has none", () => {
    const dir = setup(undefined);
    const result = checkGate(dir, {
      signals: { changedPaths: ["anything/at/all.ts"] },
    });
    expect(result.budget).toBeUndefined();
    expect(result.status).toBe("ok");
  });

  it("blocks with a non-zero exit when a frozen contract carries a whitespace-padded budget entry, even with no diff", () => {
    // The schema pattern added alongside this validator already refuses a
    // leading/trailing-whitespace entry when the contract is loaded, so this
    // reaches readContract's existing "Intent contract is invalid" path
    // rather than the gate's own budget-path check below. Either way it must
    // fail closed: non-zero exit, and the offending field named.
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - " src/legacy/** "\n',
    );
    const result = checkGate(dir, {});
    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((r) => r.includes("protected_paths"))).toBe(true);
  });

  it("blocks with a non-zero exit when a frozen contract carries a '..' segment, even with no diff", () => {
    // Not covered by the schema's pattern (see intent-contract.schema.json),
    // so this is what actually exercises the gate's own validateBudgetPaths
    // check, independent of whether there is a diff to evaluate the budget
    // against.
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - "../x"\n',
    );
    const result = checkGate(dir, {});
    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(
      result.reasons.some((r) => r.includes("protected_paths") && r.includes("../x")),
    ).toBe(true);
  });
});
