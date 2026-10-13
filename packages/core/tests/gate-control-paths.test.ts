import { describe, it, expect } from "vitest";
import { changedControlPaths } from "../src/gate.js";

// The paths that make `check --base` without `--trust-base` warn: every
// control input the gate reads from the tree it judges, in the current and the
// legacy state directory, at the repository root or under a --project
// subdirectory.
describe("changedControlPaths", () => {
  it("names the contract and config in the current state directory", () => {
    expect(
      changedControlPaths([".intent-guard/intent-contract.yaml", ".intent-guard/config.yaml"]),
    ).toEqual([".intent-guard/intent-contract.yaml", ".intent-guard/config.yaml"]);
  });

  it("names the contract and config in the legacy .conductor directory", () => {
    expect(
      changedControlPaths([".conductor/intent-contract.yaml", ".conductor/config.yaml"]),
    ).toEqual([".conductor/intent-contract.yaml", ".conductor/config.yaml"]);
  });

  it("names anything under the contracts archive, in either directory", () => {
    expect(
      changedControlPaths([
        ".intent-guard/contracts/ic-20260101-abcdef.yaml",
        ".conductor/contracts/ic-20250101-abcdef.yaml",
      ]),
    ).toEqual([
      ".intent-guard/contracts/ic-20260101-abcdef.yaml",
      ".conductor/contracts/ic-20250101-abcdef.yaml",
    ]);
  });

  it("names them under a --project subdirectory too", () => {
    expect(
      changedControlPaths([
        "apps/web/.intent-guard/intent-contract.yaml",
        "apps/web/.conductor/config.yaml",
        "apps/web/.intent-guard/contracts/ic-1.yaml",
      ]),
    ).toHaveLength(3);
  });

  it("ignores files the gate does not read as a control input", () => {
    expect(
      changedControlPaths([
        "examples/intent-contract.yaml",
        ".intent-guard/index.md",
        ".intent-guard/drift-log.jsonl",
        ".intent-guard-old/config.yaml",
        "docs/contracts/ic-1.yaml",
        "src/config.yaml",
      ]),
    ).toEqual([]);
  });
});
