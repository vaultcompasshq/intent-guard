import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initConductor } from "../src/init.js";
import { freezeContract, writeContract } from "../src/contract-store.js";
import { checkGate } from "../src/gate.js";
import type { IntentContract } from "@vaultcompass/conductor-schema";

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
});
