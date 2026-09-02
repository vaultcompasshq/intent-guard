import { describe, expect, it } from "vitest";
import { findingFingerprint } from "../src/fingerprint.js";

describe("findingFingerprint", () => {
  it("is stable for identical input", () => {
    const input = {
      contractId: "c-2026-09-02-export",
      ruleId: "protected_paths",
      matched: ["src/auth/session.ts", "src/billing/stripe.ts"],
    };

    expect(findingFingerprint(input)).toBe(findingFingerprint(input));
    expect(findingFingerprint({ ...input })).toBe(findingFingerprint(input));
  });

  it("ignores the order of the matched set", () => {
    const a = findingFingerprint({
      contractId: "c-1",
      ruleId: "allowed_paths",
      matched: ["a.ts", "b.ts", "c.ts"],
    });
    const b = findingFingerprint({
      contractId: "c-1",
      ruleId: "allowed_paths",
      matched: ["c.ts", "a.ts", "b.ts"],
    });

    expect(a).toBe(b);
  });

  it("changes when the contract id changes", () => {
    const base = { ruleId: "max_files", matched: ["a.ts"] };
    expect(findingFingerprint({ ...base, contractId: "c-1" })).not.toBe(
      findingFingerprint({ ...base, contractId: "c-2" }),
    );
  });

  it("changes when the rule id changes", () => {
    const base = { contractId: "c-1", matched: ["a.ts"] };
    expect(findingFingerprint({ ...base, ruleId: "allowed_paths" })).not.toBe(
      findingFingerprint({ ...base, ruleId: "protected_paths" }),
    );
  });

  it("changes when the matched set changes", () => {
    const base = { contractId: "c-1", ruleId: "allowed_paths" };
    expect(findingFingerprint({ ...base, matched: ["a.ts"] })).not.toBe(
      findingFingerprint({ ...base, matched: ["a.ts", "b.ts"] }),
    );
  });

  it("normalizes path spellings that mean the same file", () => {
    const plain = findingFingerprint({
      contractId: "c-1",
      ruleId: "allowed_paths",
      matched: ["src/a.ts"],
    });

    // A leading ./, a Windows separator, surrounding whitespace, and a
    // duplicate are all the same finding.
    expect(
      findingFingerprint({
        contractId: "c-1",
        ruleId: "allowed_paths",
        matched: ["./src/a.ts"],
      }),
    ).toBe(plain);
    expect(
      findingFingerprint({
        contractId: "c-1",
        ruleId: "allowed_paths",
        matched: ["src\\a.ts"],
      }),
    ).toBe(plain);
    expect(
      findingFingerprint({
        contractId: "c-1",
        ruleId: "allowed_paths",
        matched: ["  src/a.ts  ", "src/a.ts", ""],
      }),
    ).toBe(plain);
  });

  it("cannot be forged by moving text across the field boundary", () => {
    // Naive joining would make these two collide.
    expect(
      findingFingerprint({ contractId: "ab", ruleId: "c", matched: [] }),
    ).not.toBe(
      findingFingerprint({ contractId: "a", ruleId: "bc", matched: [] }),
    );
  });

  it("is a 64-character lowercase hex sha256", () => {
    const id = findingFingerprint({
      contractId: "c-1",
      ruleId: "max_files",
      matched: ["a.ts"],
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the published recipe", () => {
    // A pinned vector. This is the contract with the umbrella and with any
    // baseline file that stores fingerprints: if this value changes, ids
    // recorded by an older version stop matching, and that is a breaking
    // change requiring a new recipe version, not a silent edit.
    expect(
      findingFingerprint({
        contractId: "c-1",
        ruleId: "protected_paths",
        matched: ["src/b.ts", "src/a.ts"],
      }),
    ).toBe("bc5caabc80eecdd23e1831845f187d6b07b479b861ae17305f0666e36833fd30");
  });
});
