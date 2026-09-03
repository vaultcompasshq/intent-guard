import { describe, expect, it } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { evaluateBudget } from "../src/budget.js";
import { scoreDrift } from "../src/drift.js";
import { findingFingerprint } from "../src/fingerprint.js";

const contract: IntentContract = {
  contract_id: "ic-20260902-aa11bb",
  version: "1.0.0",
  original_ask: "Add CSV export to the reports page.",
  in_scope: ["CSV export on the reports page"],
  out_of_scope: ["Authentication and session handling"],
  constraints: [
    { rule: "No new API endpoints", priority: "critical" },
  ],
  acceptance_criteria: [
    { id: "ac-1", description: "Report rows export as CSV", testable: true },
  ],
  frozen_at: "2026-09-02T10:00:00Z",
  pivot_log: [],
  budget: {
    protected_paths: ["src/auth/**"],
    max_files: 1,
  },
};

function otherContract(): IntentContract {
  return { ...contract, contract_id: "ic-20260902-zz99yy" };
}

describe("budget violation fingerprints", () => {
  const paths = ["src/auth/session.ts", "src/reports/export.ts"];

  it("is identical for identical input", () => {
    const first = evaluateBudget(contract, paths);
    const second = evaluateBudget(contract, paths);

    expect(first.violations.length).toBeGreaterThan(0);
    expect(first.violations.map((v) => v.fingerprint)).toEqual(
      second.violations.map((v) => v.fingerprint),
    );
    for (const violation of first.violations) {
      expect(violation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("survives a reordering of the changed paths", () => {
    const forward = evaluateBudget(contract, paths);
    const reversed = evaluateBudget(contract, [...paths].reverse());

    // Same set of findings, same ids, whatever order git listed the paths in.
    expect(new Set(reversed.violations.map((v) => v.fingerprint))).toEqual(
      new Set(forward.violations.map((v) => v.fingerprint)),
    );
  });

  it("differs for a different contract id", () => {
    const mine = evaluateBudget(contract, paths);
    const theirs = evaluateBudget(otherContract(), paths);

    expect(theirs.violations.length).toBe(mine.violations.length);
    for (let i = 0; i < mine.violations.length; i++) {
      expect(theirs.violations[i].rule).toBe(mine.violations[i].rule);
      expect(theirs.violations[i].fingerprint).not.toBe(
        mine.violations[i].fingerprint,
      );
    }
  });

  it("differs per rule within one run", () => {
    const result = evaluateBudget(contract, paths);
    const ids = result.violations.map((v) => v.fingerprint);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("drift finding fingerprints", () => {
  const signals = {
    changedPaths: ["src/auth/session.ts", "src/api/routes/export.ts"],
    signals: ["added authentication endpoint"],
  };

  it("is identical for identical input", () => {
    const first = scoreDrift(contract, signals);
    const second = scoreDrift(contract, signals);

    expect(first.finding_details.length).toBeGreaterThan(0);
    expect(first.finding_details.map((f) => f.fingerprint)).toEqual(
      second.finding_details.map((f) => f.fingerprint),
    );
  });

  it("survives a reordering of the changed paths", () => {
    const forward = scoreDrift(contract, signals);
    const reversed = scoreDrift(contract, {
      ...signals,
      changedPaths: [...signals.changedPaths].reverse(),
    });

    // Note: for this contract and these signals, scoreDrift's own matched
    // arrays come out in the same order forward and reversed regardless of
    // canonicalMatched's sort, because they are built by iterating token sets
    // derived from the contract text, not from changedPaths order. That is
    // what makes the case below load-bearing where this one is not.
    expect(new Set(reversed.finding_details.map((f) => f.fingerprint))).toEqual(
      new Set(forward.finding_details.map((f) => f.fingerprint)),
    );
  });

  it("is unchanged when a drift finding's matched token set is built in a different order", () => {
    // scoreDrift's own matched arrays do not vary in order for a fixed
    // contract and fixed signals (see the case above), so this drives
    // findingFingerprint directly with the same contract id and the same
    // rule id a real constraint_violation finding would use, and only the
    // order of the matched tokens differs. This is what actually exercises
    // canonicalMatched's sort for a drift-shaped finding: removing the sort
    // makes forward and reversed hash differently.
    const ruleId = "constraint_violation:No new API endpoints";
    const matched = ["endpoint", "authentication", "session"];

    const forward = findingFingerprint({
      contractId: contract.contract_id,
      ruleId,
      matched,
    });
    const reversed = findingFingerprint({
      contractId: contract.contract_id,
      ruleId,
      matched: [...matched].reverse(),
    });

    expect(reversed).toBe(forward);
  });

  it("differs for a different contract id", () => {
    const mine = scoreDrift(contract, signals);
    const theirs = scoreDrift(otherContract(), signals);

    expect(theirs.finding_details.length).toBe(mine.finding_details.length);
    for (let i = 0; i < mine.finding_details.length; i++) {
      expect(theirs.finding_details[i].rule_id).toBe(
        mine.finding_details[i].rule_id,
      );
      expect(theirs.finding_details[i].fingerprint).not.toBe(
        mine.finding_details[i].fingerprint,
      );
    }
  });

  it("keeps findings and finding_details in step", () => {
    const score = scoreDrift(contract, signals);
    expect(score.findings).toEqual(score.finding_details.map((f) => f.message));
  });

  it("does not change when a constraint's priority is edited", () => {
    // The rule is the same rule. Raising its priority changes the score and
    // the message, not the identity of the finding.
    const raised: IntentContract = {
      ...contract,
      constraints: [{ rule: "No new API endpoints", priority: "low" }],
    };

    const before = scoreDrift(contract, signals).finding_details.filter(
      (f) => f.category === "constraint_violation",
    );
    const after = scoreDrift(raised, signals).finding_details.filter(
      (f) => f.category === "constraint_violation",
    );

    expect(before.length).toBeGreaterThan(0);
    expect(after.map((f) => f.fingerprint)).toEqual(
      before.map((f) => f.fingerprint),
    );
    // The message did move, which is exactly what must not affect the id.
    expect(after[0].message).not.toBe(before[0].message);
  });
});
