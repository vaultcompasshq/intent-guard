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
 * yaml file directly, bypassing freezeContract's own validation entirely --
 * the way a human hand-editing the file after freezing would, or how a
 * contract frozen before this validator existed would look today.
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

  it("warns without blocking when a frozen contract carries a whitespace-padded budget entry, even with no diff", () => {
    // Exercises the gate's own validateBudgetPaths check directly: nothing
    // in the schema catches this (the schema only requires minLength 1), so
    // this is the only path that surfaces it for an already-frozen contract.
    // 1.7.0 warns rather than blocks (docs/release/stability-policy.md's
    // deprecation rule); 2.0.0 turns this into a blocking reason.
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - " src/legacy/** "\n',
    );
    const result = checkGate(dir, {});
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("protected_paths") && w.includes("src/legacy/**") && w.includes("2.0.0"),
      ),
    ).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("warns without blocking when a frozen contract carries a '..' segment, even with no diff", () => {
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - "../x"\n',
    );
    const result = checkGate(dir, {});
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(
      result.warnings.some(
        (w) => w.includes("protected_paths") && w.includes("../x") && w.includes("2.0.0"),
      ),
    ).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("warns without blocking when a frozen contract carries a wildcard glob ending in '/', and says it protects nothing", () => {
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - "secrets/**/"\n',
    );
    // The premise: the entry matches no git path, which never ends in '/'.
    const touched = checkGate(dir, { signals: { changedPaths: ["secrets/k.txt"] } });
    expect(touched.budget?.ok).toBe(true);

    const result = checkGate(dir, {});
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("protected_paths") &&
          w.includes("secrets/**/") &&
          w.includes("protects nothing") &&
          w.includes("2.0.0"),
      ),
    ).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("does not block on a protected_paths entry with a brace group, a character class, or a leading '-'", () => {
    // Contract-level accepts these: they are literal characters to the
    // matcher, and real git paths can contain them (app/[slug]/** is a
    // Next.js/SvelteKit dynamic-route directory).
    const dir = setupHandFrozenWithInvalidBudget(
      'budget:\n  protected_paths:\n    - "src/{a,b}/**"\n    - "app/[slug]/**"\n    - "-legacy/**"\n',
    );
    const result = checkGate(dir, {});
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });
});
