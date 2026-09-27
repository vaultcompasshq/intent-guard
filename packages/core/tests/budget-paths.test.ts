import { describe, it, expect } from "vitest";
import {
  describeBudgetPathIssue,
  validateBudgetGlob,
  validateProtectedPathFlag,
  validateBudgetPaths,
} from "../src/budget-paths.js";

// Contract-level rules: what any protected_paths/allowed_paths entry has to
// look like once it is IN a contract (extract, import-spec, freeze, check,
// report). A leading '-', a brace group, or a character class are all
// LITERAL characters to budget.ts's matchesGlob, and real paths can and do
// contain them -- app/[slug]/** is a Next.js/SvelteKit dynamic-route
// directory, and -legacy/** is a directory that happens to start with a
// dash -- so none of the three is rejected here. They are rejected only at
// the extract --protected-path flag (validateProtectedPathFlag below),
// where they are more likely a typo than an intended literal match.
describe("validateBudgetGlob (contract-level)", () => {
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

  it("accepts a value starting with '-', a literal character to the matcher", () => {
    expect(validateBudgetGlob("-legacy/**")).toBeNull();
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

  it("accepts a value with a brace group, matched as literal characters", () => {
    expect(validateBudgetGlob("src/{legacy,vendor}/**")).toBeNull();
  });

  it("accepts a value with a character class, matched as literal characters", () => {
    expect(validateBudgetGlob("app/[slug]/**")).toBeNull();
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

  it("rejects a value that is just './', which normalizes to nothing", () => {
    expect(validateBudgetGlob("./")).not.toBeNull();
  });

  it("accepts a value with no empty segment", () => {
    expect(validateBudgetGlob("src/legacy/**")).toBeNull();
  });

  it("rejects a value with an empty segment (consecutive slashes)", () => {
    expect(validateBudgetGlob("src//x")).not.toBeNull();
  });

  it("accepts a value with a trailing double slash, which the matcher strips to a working prefix", () => {
    // budget.ts's matchesGlob strips trailing slashes with /\/+$/ before
    // comparing a no-wildcard glob, so src// is exactly as working as src or
    // src/. Only an INTERNAL empty segment (src//x, above) can never match.
    expect(validateBudgetGlob("src//")).toBeNull();
  });
});

// Flag-level rules: extract --protected-path only. A superset of the
// contract-level rules, plus two checks that only make sense on a command
// line: a leading '-' looks like a flag, and braces/brackets are more likely
// a mistaken attempt at shell-style expansion than an intended literal glob.
describe("validateProtectedPathFlag (extract --protected-path only)", () => {
  it("accepts an ordinary relative glob", () => {
    expect(validateProtectedPathFlag("src/legacy/**")).toBeNull();
  });

  it("rejects a value starting with '-'", () => {
    expect(validateProtectedPathFlag("-legacy/**")).not.toBeNull();
  });

  it("rejects a value with a brace group", () => {
    expect(validateProtectedPathFlag("src/{legacy,vendor}/**")).not.toBeNull();
  });

  it("rejects a value with a character class", () => {
    expect(validateProtectedPathFlag("app/[slug]/**")).not.toBeNull();
  });

  it("still applies every contract-level rule, such as rejecting a '..' segment", () => {
    expect(validateProtectedPathFlag("../secrets/**")).not.toBeNull();
  });

  it("still applies every contract-level rule, such as accepting a leading './'", () => {
    expect(validateProtectedPathFlag("./src/**")).toBeNull();
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

  it("does not flag a brace group, a character class, or a leading '-' -- those are contract-level valid", () => {
    expect(
      validateBudgetPaths({
        protected_paths: ["src/{a,b}/**", "app/[slug]/**", "-legacy/**"],
      }),
    ).toEqual([]);
  });

  it("collects one issue per invalid entry, naming the rule and the value", () => {
    const issues = validateBudgetPaths({
      protected_paths: ["/etc/**", "src/legacy/**"],
      allowed_paths: ["../y"],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0].rule).toBe("protected_paths");
    expect(issues[0].value).toBe("/etc/**");
    expect(issues[0].reason.length).toBeGreaterThan(0);
    expect(issues[1].rule).toBe("allowed_paths");
    expect(issues[1].value).toBe("../y");
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
