import { describe, it, expect } from "vitest";
import {
  describeBudgetPathIssue,
  validateBudgetGlob,
  validateBudgetPaths,
} from "../src/budget-paths.js";

describe("validateBudgetGlob", () => {
  it("accepts an ordinary relative glob", () => {
    expect(validateBudgetGlob("src/legacy/**")).toBeNull();
  });

  it("rejects an empty value", () => {
    expect(validateBudgetGlob("")).not.toBeNull();
  });

  it("rejects a whitespace-only value", () => {
    expect(validateBudgetGlob("   ")).not.toBeNull();
  });

  it("accepts a value with no surrounding whitespace", () => {
    expect(validateBudgetGlob("src/**")).toBeNull();
  });

  it("rejects a value with leading or trailing whitespace", () => {
    expect(validateBudgetGlob(" src/legacy/** ")).not.toBeNull();
  });

  it("accepts a value that does not start with '-'", () => {
    expect(validateBudgetGlob("file.ts")).toBeNull();
  });

  it("rejects a value starting with '-'", () => {
    expect(validateBudgetGlob("-file.ts")).not.toBeNull();
  });

  it("accepts a value that does not start with '/'", () => {
    expect(validateBudgetGlob("etc/**")).toBeNull();
  });

  it("rejects a value with a leading slash", () => {
    expect(validateBudgetGlob("/etc/**")).not.toBeNull();
  });

  it("accepts a value with no backslash", () => {
    expect(validateBudgetGlob("src/legacy/**")).toBeNull();
  });

  it("rejects a value containing a backslash", () => {
    expect(validateBudgetGlob("src\\legacy\\**")).not.toBeNull();
  });

  it("accepts a value with no brace group or character class", () => {
    expect(validateBudgetGlob("src/legacy/**")).toBeNull();
  });

  it("rejects a value with a brace group", () => {
    expect(validateBudgetGlob("src/{legacy,vendor}/**")).not.toBeNull();
  });

  it("rejects a value with a character class", () => {
    expect(validateBudgetGlob("src/[ab]/**")).not.toBeNull();
  });

  it("accepts a value with no '..' segment", () => {
    expect(validateBudgetGlob("src/legacy/**")).toBeNull();
  });

  it("rejects a value with a '..' segment", () => {
    expect(validateBudgetGlob("../secrets/**")).not.toBeNull();
  });

  it("accepts a leading './' segment", () => {
    expect(validateBudgetGlob("./src/**")).toBeNull();
  });

  it("rejects a '.' segment that is not a leading './'", () => {
    expect(validateBudgetGlob("src/./x")).not.toBeNull();
  });
});

describe("validateBudgetPaths", () => {
  it("returns no issues for a valid budget", () => {
    expect(
      validateBudgetPaths({
        protected_paths: ["src/legacy/**"],
        allowed_paths: ["src/payments/**"],
      }),
    ).toEqual([]);
  });

  it("returns no issues for an absent budget", () => {
    expect(validateBudgetPaths(undefined)).toEqual([]);
  });

  it("collects one issue per invalid entry, naming the rule and the value", () => {
    const issues = validateBudgetPaths({
      protected_paths: ["/etc/**", "src/legacy/**"],
      allowed_paths: ["src/{a,b}/**"],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0].rule).toBe("protected_paths");
    expect(issues[0].value).toBe("/etc/**");
    expect(issues[0].reason.length).toBeGreaterThan(0);
    expect(issues[1].rule).toBe("allowed_paths");
    expect(issues[1].value).toBe("src/{a,b}/**");
  });
});

describe("describeBudgetPathIssue", () => {
  it("names the rule, the offending value, and the reason", () => {
    const [issue] = validateBudgetPaths({ protected_paths: ["../x"] });
    const line = describeBudgetPathIssue(issue);
    expect(line).toContain("protected_paths");
    expect(line).toContain("../x");
    expect(line).toContain(issue.reason);
  });
});
