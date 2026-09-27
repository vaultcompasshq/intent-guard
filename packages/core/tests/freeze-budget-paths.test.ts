import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { freezeContract } from "../src/contract-store.js";

function draftContract(budget: IntentContract["budget"]): IntentContract {
  return {
    contract_id: "ic-20260728-f1e2d3",
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

describe("freezeContract budget path validation", () => {
  it("freezes a contract whose budget carries only valid globs", () => {
    const frozen = freezeContract(draftContract({ protected_paths: ["src/legacy/**"] }), {
      approvedBy: "tester",
      method: "explicit-flag",
    });
    expect(frozen.approval?.approved_by).toBe("tester");
  });

  it("refuses to freeze a contract whose protected_paths carries a '..' segment", () => {
    expect(() =>
      freezeContract(draftContract({ protected_paths: ["../x"] }), {
        approvedBy: "tester",
        method: "explicit-flag",
      }),
    ).toThrow(/\.\.\/x/);
  });

  it("freezes a contract whose protected_paths carries a brace group, a character class, and a leading '-'", () => {
    // Contract-level accepts these: they are literal characters to the
    // matcher, and real git paths (app/[slug]/** is a Next.js/SvelteKit
    // dynamic-route directory) can contain them. Only the extract
    // --protected-path flag rejects them.
    const frozen = freezeContract(
      draftContract({
        protected_paths: ["src/{a,b}/**", "app/[slug]/**", "-legacy/**"],
      }),
      { approvedBy: "tester", method: "explicit-flag" },
    );
    expect(frozen.approval?.approved_by).toBe("tester");
  });
});
