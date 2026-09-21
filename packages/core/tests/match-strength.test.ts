import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { scoreDrift, targetTokens } from "../src/drift.js";
import { findingFingerprint } from "../src/fingerprint.js";
import {
  matchStrength,
  slashJoinedPathHits,
} from "../src/tokenize.js";

const THRESHOLDS = { strong_coverage: 0.5, partial_coverage: 0.3 };

function contract(overrides: Partial<IntentContract> = {}): IntentContract {
  return {
    contract_id: "ic-20260921-match01",
    version: "1.0.0",
    original_ask: "Add a settings toggle.",
    in_scope: ["Settings toggle on the settings page"],
    out_of_scope: ["billing"],
    constraints: [],
    acceptance_criteria: [
      { id: "ac-1", description: "Toggle persists", testable: true },
    ],
    frozen_at: "2026-09-21T00:00:00Z",
    pivot_log: [],
    ...overrides,
  };
}

describe("matchStrength", () => {
  it("returns none for stopword-only overlap", () => {
    expect(
      matchStrength(new Set(["billing", "export"]), ["the", "and", "of"], THRESHOLDS),
    ).toBe("none");
  });

    it("returns partial when the only evidence is a category token", () => {
    expect(
      matchStrength(new Set(["documentation", "cleanup"]), ["documentation"], THRESHOLDS),
    ).toBe("partial");
  });

  it("returns strong for a 1-token item fully matched", () => {
    expect(matchStrength(new Set(["billing"]), ["billing"], THRESHOLDS)).toBe("strong");
  });

  it("returns none when one incidental token is a small fraction of a multi-token item", () => {
    expect(
      matchStrength(
        new Set(["customer", "portal", "notes", "export", "cleanup"]),
        ["notes"],
        THRESHOLDS,
      ),
    ).toBe("none");
  });
});

describe("scoreDrift coverage threshold", () => {
  it("does not count a multi-token out-of-scope item that shares one generic word with a docs path toward blocking", () => {
    // Representative of the incidental-overlap false blocks: a long out-of-scope
    // phrase and a docs change that share one ordinary word.
    const result = scoreDrift(
      contract({
        out_of_scope: ["customer portal notes and export cleanup"],
      }),
      { changedPaths: ["docs/notes.md"] },
    );
    expect(result.categories.scope_creep).toBe(0);
    expect(result.action).not.toMatch(/block/);
    const creep = result.finding_details.filter((f) => f.category === "scope_creep");
    for (const finding of creep) {
      expect(finding.strength).not.toBe("strong");
    }
  });

  it("is strong when a 1-token item billing is touched by src/billing/x.ts", () => {
    const result = scoreDrift(contract({ out_of_scope: ["billing"] }), {
      changedPaths: ["src/billing/x.ts"],
    });
    expect(result.categories.scope_creep).toBe(40);
    const finding = result.finding_details.find((f) => f.category === "scope_creep");
    expect(finding?.strength).toBe("strong");
    expect(finding?.matched).toContain("billing");
  });

  it("records a category-only README match as partial and advisory", () => {
    const result = scoreDrift(
      contract({
        out_of_scope: ["documentation cleanup"],
      }),
      { changedPaths: ["README.md"] },
    );
    expect(result.categories.scope_creep).toBe(0);
    const finding = result.finding_details.find((f) => f.category === "scope_creep");
    expect(finding?.strength).toBe("partial");
    expect(finding?.message).toMatch(/^possible /);
  });

  it("does not go strong for a design-system-tokens constraint against tokens.ts", () => {
    const result = scoreDrift(
      contract({
        out_of_scope: [],
        constraints: [
          {
            source: "CLAUDE.md",
            rule: "Use design system tokens, never raw values",
            priority: "critical",
          },
        ],
      }),
      { changedPaths: ["src/design-system/tokens.ts"] },
    );
    expect(result.categories.constraint_violation).toBe(0);
    const findings = result.finding_details.filter(
      (f) => f.category === "constraint_violation",
    );
    for (const finding of findings) {
      expect(finding.strength).not.toBe("strong");
    }
  });

  it("matches slash-joined path fragments by consecutive whole segments", () => {
    const item = "packages/cli full binary (Phase 4)";
    expect(slashJoinedPathHits(item, ["packages/cli/src/index.ts"])).toEqual([
      "packages/cli",
    ]);
    expect(slashJoinedPathHits(item, ["packages/client/x.ts"])).toEqual([]);
    expect(slashJoinedPathHits(item, ["cli/packages/x.ts"])).toEqual([]);

    const result = scoreDrift(contract({ out_of_scope: [item] }), {
      changedPaths: ["packages/cli/src/index.ts"],
    });
    expect(result.categories.scope_creep).toBe(40);
    const finding = result.finding_details.find((f) => f.category === "scope_creep");
    expect(finding?.strength).toBe("strong");
  });

  it("keeps the fingerprint of a strong finding independent of the strength field", () => {
    const result = scoreDrift(contract({ out_of_scope: ["billing"] }), {
      changedPaths: ["src/billing/x.ts"],
    });
    const finding = result.finding_details.find((f) => f.category === "scope_creep");
    expect(finding).toBeDefined();
    expect(finding?.strength).toBe("strong");
    expect(finding?.fingerprint).toBe(
      findingFingerprint({
        contractId: "ic-20260921-match01",
        ruleId: "scope_creep:billing",
        matched: finding!.matched,
      }),
    );
  });

  it("records a partial constraint as advisory and does not set constraintViolation", () => {
    const result = scoreDrift(
      contract({
        out_of_scope: [],
        constraints: [
          {
            source: "CLAUDE.md",
            rule: "Do not rewrite customer portal notes and export cleanup",
            priority: "critical",
          },
        ],
      }),
      { changedPaths: ["docs/notes.md"] },
    );
    expect(result.categories.constraint_violation).toBe(0);
    const advisory = result.finding_details.filter((f) => f.category === "constraint_violation");
    for (const finding of advisory) {
      expect(finding.strength).toBe("partial");
      expect(finding.message).toMatch(/^possible /);
    }
  });

  it("sets constraintViolation only on a strong constraint match", () => {
    const result = scoreDrift(
      contract({
        out_of_scope: [],
        constraints: [
          {
            source: "CLAUDE.md",
            rule: "Never billing",
            priority: "critical",
          },
        ],
      }),
      { changedPaths: ["src/billing/x.ts"] },
    );
    expect(result.categories.constraint_violation).toBe(90);
    const finding = result.finding_details.find((f) => f.category === "constraint_violation");
    expect(finding?.strength).toBe("strong");
    expect(finding?.message).not.toMatch(/^possible /);
  });

  it("derives target tokens only from the input changed paths and signals", () => {
    const fromPaths = targetTokens({
      changedPaths: ["src/app.ts"],
      signals: ["added settings toggle"],
    });
    expect([...fromPaths.all]).not.toContain("billing");
    expect(fromPaths.all.size).toBeGreaterThan(0);

    const withBilling = targetTokens({
      changedPaths: ["src/app.ts", "src/billing/x.ts"],
    });
    expect([...withBilling.all]).toContain("billing");

    const untouched = scoreDrift(contract({ out_of_scope: ["billing"] }), {
      changedPaths: ["src/app.ts"],
      signals: ["added settings toggle"],
    });
    expect(untouched.categories.scope_creep).toBe(0);
  });
});
