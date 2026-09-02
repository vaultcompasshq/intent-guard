import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { evaluateBudget, matchesGlob } from "../src/budget.js";

const base: IntentContract = {
  contract_id: "ic-20260728-b1c2d3",
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
};

function withBudget(budget: IntentContract["budget"]): IntentContract {
  return { ...base, budget };
}

describe("matchesGlob", () => {
  it("matches ** across directory segments", () => {
    expect(matchesGlob("packages/core/src/budget.ts", "packages/core/**")).toBe(true);
    expect(matchesGlob("packages/cli/src/x.ts", "packages/core/**")).toBe(false);
  });

  it("matches * within a single segment only", () => {
    expect(matchesGlob("src/legacy.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
  });

  it("matches ** anywhere in the path", () => {
    expect(matchesGlob("app/legacy/handler.ts", "**/legacy/**")).toBe(true);
    expect(matchesGlob("legacy/handler.ts", "**/legacy/**")).toBe(true);
  });

  it("matches a single ? character", () => {
    expect(matchesGlob("v1.ts", "v?.ts")).toBe(true);
    expect(matchesGlob("v10.ts", "v?.ts")).toBe(false);
  });

  it("treats a wildcard-free glob as a directory prefix", () => {
    expect(matchesGlob("source/index.ts", "source")).toBe(true);
    expect(matchesGlob("source/index.ts", "source/")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src")).toBe(true);
    expect(matchesGlob("other/x.ts", "src")).toBe(false);
    expect(matchesGlob("srcextra/x.ts", "src")).toBe(false);
  });

  it("still exact-matches a wildcard-free file glob", () => {
    expect(matchesGlob("package.json", "package.json")).toBe(true);
    expect(matchesGlob("packages/core/package.json", "package.json")).toBe(false);
  });

  it("normalizes leading ./ on both path and glob", () => {
    expect(matchesGlob("./src/index.ts", "src/**")).toBe(true);
    expect(matchesGlob("src/index.ts", "./src/**")).toBe(true);
    expect(matchesGlob("./src/index.ts", "src")).toBe(true);
  });
});

describe("evaluateBudget", () => {
  it("returns ok when no budget is set", () => {
    const result = evaluateBudget(base, ["anything.ts"]);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("ok");
    expect(result.violations).toEqual([]);
  });

  it("hard_blocks a touch of a protected path", () => {
    const result = evaluateBudget(
      withBudget({ protected_paths: ["**/legacy/**"] }),
      ["src/payments/client.ts", "src/legacy/error-format.ts"],
    );
    expect(result.action).toBe("hard_block");
    const v = result.violations.find((x) => x.rule === "protected_paths");
    expect(v?.severity).toBe("hard_block");
    expect(v?.matched).toContain("src/legacy/error-format.ts");
  });

  it("soft_blocks a change outside allowed_paths", () => {
    const result = evaluateBudget(
      withBudget({ allowed_paths: ["src/payments/**"] }),
      ["src/payments/client.ts", "src/billing/invoice.ts"],
    );
    expect(result.action).toBe("soft_block");
    const v = result.violations.find((x) => x.rule === "allowed_paths");
    expect(v?.matched).toContain("src/billing/invoice.ts");
    expect(v?.matched).not.toContain("src/payments/client.ts");
  });

  it("passes when all changes are inside allowed_paths", () => {
    const result = evaluateBudget(
      withBudget({ allowed_paths: ["src/payments/**"] }),
      ["src/payments/client.ts", "src/payments/retry.ts"],
    );
    expect(result.ok).toBe(true);
  });

  it("soft_blocks when max_files is exceeded", () => {
    const result = evaluateBudget(
      withBudget({ max_files: 2 }),
      ["a.ts", "b.ts", "c.ts"],
    );
    expect(result.action).toBe("soft_block");
    const v = result.violations.find((x) => x.rule === "max_files");
    expect(v?.message).toMatch(/3.*2/);
  });

  it("passes at exactly max_files", () => {
    const result = evaluateBudget(withBudget({ max_files: 2 }), ["a.ts", "b.ts"]);
    expect(result.ok).toBe(true);
  });

  it("soft_blocks a manifest edit when allow_new_dependencies is false", () => {
    const result = evaluateBudget(
      withBudget({ allow_new_dependencies: false }),
      ["src/payments/client.ts", "package.json"],
    );
    expect(result.action).toBe("soft_block");
    const v = result.violations.find((x) => x.rule === "allow_new_dependencies");
    expect(v?.matched).toContain("package.json");
  });

  it("ignores manifest edits when allow_new_dependencies is true", () => {
    const result = evaluateBudget(
      withBudget({ allow_new_dependencies: true }),
      ["package.json", "pnpm-lock.yaml"],
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a protected path even when the change is a deletion", () => {
    // git diff --cached --name-only lists deleted files too, so a deleted
    // protected file still appears as a changed path and must still block.
    const result = evaluateBudget(
      withBudget({ protected_paths: ["config/secrets.enc"] }),
      ["config/secrets.enc"],
    );
    expect(result.action).toBe("hard_block");
  });

  it("escalates to hard_block when protected and soft rules both fire", () => {
    const result = evaluateBudget(
      withBudget({ protected_paths: ["**/legacy/**"], max_files: 1 }),
      ["src/legacy/x.ts", "src/a.ts", "src/b.ts"],
    );
    expect(result.action).toBe("hard_block");
    expect(result.violations.length).toBe(2);
  });
});
