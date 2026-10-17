import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { extractConstraintsFromMarkdown } from "../src/constraints.js";
import { draftContract } from "../src/extract.js";
import { scoreDrift } from "../src/drift.js";
import { importSpecContract } from "../src/spec-bridge.js";

// Each case below blocked in 1.9.0 and passed on the first cut of the
// extraction-quality change. Every test pins the block.

function contractWith(
  outOfScope: string[],
  constraints: IntentContract["constraints"] = [],
): IntentContract {
  return {
    contract_id: "ic-20261017-cccccc",
    version: "1.0.0",
    original_ask: "Add a theme toggle to the settings page.",
    in_scope: ["Theme toggle on the settings page"],
    out_of_scope: outOfScope,
    constraints,
    acceptance_criteria: [{ id: "ac-1", description: "Toggle switches the theme", testable: true }],
    frozen_at: "2026-10-17T00:00:00Z",
    pivot_log: [],
  };
}

const blocks = (action: string): boolean => action === "soft_block" || action === "hard_block";

describe("a prohibition in the ask is never subtracted as agreed scope", () => {
  const asks = [
    "Add a theme toggle. Keep the change small and never touch billing.",
    "Add a theme toggle. It must not change billing.",
    "Add a theme toggle. Please do not modify billing.",
    "Add a theme toggle. Then, do not modify billing.",
  ];
  for (const ask of asks) {
    it(`still blocks a billing path for: ${ask}`, () => {
      const contract = draftContract({ userText: ask });
      expect(contract.out_of_scope.join(" ")).toMatch(/billing/i);
      const result = scoreDrift(contract, { changedPaths: ["src/billing/invoice.ts"] });
      expect(blocks(result.action)).toBe(true);
    });
  }

  it("never subtracts an ask token that an out_of_scope item or a constraint uses", () => {
    // The ask's positive sentence also says billing; the item still matches.
    const item = scoreDrift(
      { ...contractWith(["Do not modify billing"]), original_ask: "Show the billing total on the theme page." },
      { changedPaths: ["src/billing/invoice.ts"] },
    );
    expect(blocks(item.action)).toBe(true);
    const constraint = scoreDrift(
      {
        ...contractWith([], [{ source: "user-stated", rule: "Never modify billing", priority: "critical" }]),
        original_ask: "Show the billing total on the theme page.",
      },
      { changedPaths: ["src/billing/invoice.ts"] },
    );
    expect(constraint.categories.constraint_violation).toBe(90);
  });

  it("still subtracts an in_scope token shared with an out_of_scope item", () => {
    // In scope CSV export, out of scope PDF export: export is agreed work.
    const result = scoreDrift(
      { ...contractWith(["PDF export"]), in_scope: ["Client-side CSV export of the fund table"] },
      { changedPaths: ["src/export/csv.ts"] },
    );
    expect(result.categories.scope_creep).toBe(0);
  });
});

describe("a rule token equal to a changed file's name is a path match", () => {
  const cases: Array<[string, string]> = [
    ["Never commit .env.local", "apps/web/.env.local"],
    ["Never commit .env.production", ".env.production"],
    ["Never edit CODEOWNERS", ".github/CODEOWNERS"],
    ["Do not edit the Dockerfile", "Dockerfile"],
    ["Do not change the Makefile", "Makefile"],
    ["Do not change the LICENSE", "LICENSE"],
  ];
  for (const [rule, path] of cases) {
    it(`blocks "${rule}" against ${path}`, () => {
      const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
      expect(blocks(result.action)).toBe(true);
    });
  }

  it("matches a backticked token and a basename without its final extension", () => {
    const backticked = scoreDrift(contractWith(["Do not edit `schema.prisma`"]), {
      changedPaths: ["prisma/schema.prisma"],
    });
    expect(blocks(backticked.action)).toBe(true);
    const stem = scoreDrift(contractWith(["Do not touch the CHANGELOG"]), { changedPaths: ["CHANGELOG.md"] });
    expect(blocks(stem.action)).toBe(true);
  });
});

describe("constraints keep their full strength; the name-only demotion is out_of_scope only", () => {
  const cases: Array<[string, string]> = [
    ["Never modify billing", "src/billing.ts"],
    ["Never change the payments code", "payments.py"],
    ["Never commit secrets", "config/secrets.json"],
    ["Never edit the lockfile", "pnpm-lock.yaml"],
  ];
  for (const [rule, path] of cases) {
    it(`blocks the constraint "${rule}" against ${path}`, () => {
      const result = scoreDrift(
        contractWith([], [{ source: "user-stated", rule, priority: "critical" }]),
        { changedPaths: [path] },
      );
      expect(result.categories.constraint_violation).toBe(90);
      expect(blocks(result.action)).toBe(true);
    });
  }

  it("counts the name token at full strength once a directory is also evidence", () => {
    const rule = "Never touch the auth middleware";
    const asConstraint = scoreDrift(
      contractWith([], [{ source: "user-stated", rule, priority: "critical" }]),
      { changedPaths: ["src/middleware/auth.ts"] },
    );
    expect(asConstraint.finding_details.find((d) => d.category === "constraint_violation")?.strength).toBe("strong");
    const asItem = scoreDrift(contractWith([rule]), { changedPaths: ["src/middleware/auth.ts"] });
    expect(asItem.finding_details.find((d) => d.category === "scope_creep")?.strength).toBe("strong");
  });

  it("counts a constraint matched only through signals", () => {
    const result = scoreDrift(
      contractWith([], [{ source: "user-stated", rule: "Never call the ledger service", priority: "critical" }]),
      { changedPaths: ["src/theme/toggle.ts"], signals: ["now calls the ledger service"] },
    );
    expect(result.categories.constraint_violation).toBe(90);
  });
});

describe("an underscore inside an identifier is part of the identifier", () => {
  it("blocks a snake_case directory named by the rule", () => {
    const result = scoreDrift(contractWith(["Never touch the payment_methods table"]), {
      changedPaths: ["db/payment_methods/schema.sql"],
    });
    expect(result.finding_details.find((d) => d.category === "scope_creep")?.strength).toBe("strong");
  });

  it("blocks a file named exactly by a snake_case rule token", () => {
    const item = scoreDrift(contractWith(["Never commit id_rsa"]), { changedPaths: ["id_rsa"] });
    expect(blocks(item.action)).toBe(true);
    const constraint = scoreDrift(
      contractWith([], [{ source: "user-stated", rule: "Never commit id_rsa", priority: "critical" }]),
      { changedPaths: ["id_rsa"] },
    );
    expect(constraint.categories.constraint_violation).toBe(90);
  });
});

describe("a mixed spec appends only its labelled file", () => {
  it("does not read an unlabelled file whole beside a labelled one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ig-mixed-"));
    const specDir = join(dir, ".kiro", "specs", "feature");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "requirements.md"), "## Requirements\n\n- Add the CSV export button\n", "utf8");
    writeFileSync(join(specDir, "design.md"), "# Design\n\nNever rewrite the ledger module.\n", "utf8");
    const { contract } = importSpecContract(dir, { format: "kiro", specDir: ".kiro/specs/feature" });
    expect(JSON.stringify(contract).toLowerCase()).not.toContain("ledger");
  });
});

describe("rule units: list intros and abbreviations", () => {
  it("does not turn an intro line ending in a colon before a list into a rule", () => {
    const rules = extractConstraintsFromMarkdown(
      ["You must follow these rules:", "", "- Never commit secrets"].join("\n"),
      "AGENTS.md",
    );
    expect(rules.map((r) => r.rule)).toEqual(["Never commit secrets"]);
  });

  it("does not end a sentence at e.g. when splitting a long paragraph", () => {
    const filler = "This paragraph explains the repository layout in some detail".repeat(4);
    const rules = extractConstraintsFromMarkdown(
      `${filler}. Never commit generated files, e.g. Build output from the bundler. The rest is context.`,
      "AGENTS.md",
    );
    expect(rules.map((r) => r.rule)).toEqual([
      "Never commit generated files, e.g. Build output from the bundler.",
    ]);
  });
});
