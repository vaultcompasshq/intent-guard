import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { scoreDrift } from "../src/drift.js";
import { checkGate, NO_CONTRACT_SKIP_REASON } from "../src/gate.js";
import { STATE_DIR } from "../src/state-dir.js";
import { namesChangedFile } from "../src/tokenize.js";

// Non-ASCII characters are built from code points, so this file stays ASCII.
const cp = (...points: number[]): string => String.fromCodePoint(...points);

// The 2026-11-01 cohesion audit's B1 and B2. Every B1 case below was
// soft_block/71 in published 1.9.0 and proceed/0 in 1.10.1 and 1.10.3,
// measured by calling scoreDrift from each published build with this same
// contract.

function contractWith(outOfScope: string[]): IntentContract {
  return {
    contract_id: "ic-20261018-cccccc",
    version: "1.0.0",
    original_ask: "Add a theme toggle to the settings page.",
    in_scope: ["Theme toggle on the settings page"],
    out_of_scope: outOfScope,
    constraints: [],
    acceptance_criteria: [{ id: "ac-1", description: "Toggle switches the theme", testable: true }],
    frozen_at: "2026-10-18T00:00:00Z",
    pivot_log: [],
  };
}

const POSSESSIVE_CASES: Array<[string, string]> = [
  ["Do not change PaymentProcessor's retry logic", "src/PaymentProcessor.ts"],
  [`Do not change PaymentProcessor${cp(0x2019)}s retry logic`, "src/PaymentProcessor.ts"],
  ["Do not change `PaymentProcessor`'s retry logic", "src/PaymentProcessor.ts"],
  ["Do not change (PaymentProcessor's) retry logic", "src/PaymentProcessor.ts"],
  ["Do not change the retry logic of PaymentProcessor's.", "src/PaymentProcessor.ts"],
  ["Do not change the router's middleware", "src/router.ts"],
  ["Do not change `router`'s middleware", "src/router.ts"],
  ['Do not change "router\'s" middleware', "src/router.ts"],
  ["Do not change the layout's grid", "src/routes/layout.svelte"],
  ["Do not change +server's handler", "src/routes/api/+server.ts"],
  ["Do not change '+layout's imports", "src/routes/+layout.svelte"],
  ["Do not change '-flag's parsing", "bin/-flag.sh"],
  ["Do not change '__init__'s exports", "pkg/__init__.py"],
  ["## Do not change '+layout's imports", "src/routes/+layout.svelte"],
  ["- Do not change '-flag's parsing", "bin/-flag.sh"],
  ["1. Do not change '__init__'s exports", "pkg/__init__.py"],
  ["> Do not change '+layout's imports", "src/routes/+layout.svelte"],
  // A bare trailing apostrophe after a word ending in s.
  ["Do not change the Payments' ledger", "src/Payments.ts"],
];

const ITALIC_CODE_SPAN_CASES: Array<[string, string]> = [
  ["Never touch _`__init__`_", "pkg/__init__.py"],
  ["Never touch _`__init__`_.", "pkg/__init__.py"],
  ["Never touch _`__about__`_", "pkg/__about__.py"],
  ["Never touch **_`__init__`_**", "pkg/__init__.py"],
  ["Never touch (_`__init__`_)", "pkg/__init__.py"],
];

// Each of these passes at head and must keep passing. The first four were
// soft_block in 1.9.0 and pass by the closed file-name rule's design: the
// word is not the changed file's name or stem, whatever the possessive or
// the emphasis does.
const LOOK_ALIKE_NEGATIVES: Array<[string, string]> = [
  ["Do not change the sync's state", "src/SyncStatus.tsx"],
  ["Do not change the router's middleware", "src/routers.ts"],
  ["Never touch _`init`_", "pkg/__init__.py"],
  ["Never touch `_init_`", "pkg/__init__.py"],
  ["Do not change the payment's retry logic", "src/PaymentProcessor.ts"],
];

describe("a possessive name blocks as it did in 1.9.0 (2026-11-01 audit B1)", () => {
  it.each(POSSESSIVE_CASES)("blocks %j against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.action).toBe("soft_block");
    expect(result.overall).toBe(71);
  });

  it("never reads a possessive's remainder as a name the file does not have", () => {
    // The remainder is a candidate only: router's names router.ts, never
    // routers.ts or Router.ts.
    expect(namesChangedFile("Do not change the router's middleware", ["src/routers.ts"])).toBe(false);
    expect(namesChangedFile("Do not change the router's middleware", ["src/Router.ts"])).toBe(false);
    expect(namesChangedFile("Do not change the sync's state", ["src/SyncStatus.tsx"])).toBe(false);
  });

  it("only stops a demotion, so a possessive with no token match still proceeds", () => {
    // "it's" reaches the stem of it.ts, but "it" is too short to be a token,
    // so there is no match for the file name to stop demoting.
    expect(namesChangedFile("Do not change it's behaviour", ["src/it.ts"])).toBe(true);
    expect(scoreDrift(contractWith(["Do not change it's behaviour"]), { changedPaths: ["src/it.ts"] }).action).toBe("proceed");
  });

  it("still names a file whose own name ends in an apostrophe and s", () => {
    expect(namesChangedFile("Do not change it's", ["docs/it's"])).toBe(true);
    expect(namesChangedFile("Do not change 'settings'", ["src/settings.ts"])).toBe(true);
  });
});

describe("an italic code span around a dunder blocks as it did in 1.9.0 (2026-11-01 audit B1)", () => {
  it.each(ITALIC_CODE_SPAN_CASES)("blocks %j against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.action).toBe("soft_block");
    expect(result.overall).toBe(71);
  });

  it("keeps the controls that blocked in every release blocking", () => {
    for (const [rule, path] of [
      ["Never touch *`__init__`*", "pkg/__init__.py"],
      ["Never touch **`__init__`**", "pkg/__init__.py"],
      ["Never touch _`Dockerfile`_", "Dockerfile"],
      ["Never touch _`__init__.py`_", "pkg/__init__.py"],
    ]) {
      expect(scoreDrift(contractWith([rule]), { changedPaths: [path] }).action, rule).toBe("soft_block");
    }
  });
});

describe("look-alike names stay a pass after the 2026-11-01 B1 fix", () => {
  it.each(LOOK_ALIKE_NEGATIVES)("proceeds on %j against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(false);
    expect(scoreDrift(contractWith([rule]), { changedPaths: [path] }).action).toBe("proceed");
  });
});

const FROZEN_CONTRACT = `contract_id: ic-20261101-aaaaaa
version: 1.0.0
original_ask: Update the readme usage docs.
in_scope:
  - Update the README usage documentation
out_of_scope:
  - Do not change billing
constraints: []
acceptance_criteria:
  - id: ac-1
    description: README documents one usage example
    testable: true
frozen_at: "2026-11-01T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: tester
  approved_at: "2026-11-01T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
`;

describe("a gate with require-frozen off and no contract says nothing was checked (2026-11-01 audit B2)", () => {
  it("returns status ok with a skipReason, exit 0, and nothing scored", () => {
    // The status stays ok in this release: conductor 0.16.0 reads only ok
    // and blocked. skipReason is what says nothing was checked.
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-skipped-"));
    const result = checkGate(dir, {
      requireFrozen: false,
      signals: { changedPaths: ["src/a.ts"] },
    });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.skipReason).toBe(NO_CONTRACT_SKIP_REASON);
    expect(result.reasons).toEqual([]);
    expect(result.contractFound).toBe(false);
    expect(result.drift).toBeUndefined();
  });

  it("still blocks a missing contract when require-frozen is on, with no skip reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-skipped-"));
    const result = checkGate(dir, { requireFrozen: true });
    expect(result.status).toBe("blocked");
    expect(result.skipReason).toBeUndefined();
  });

  it("leaves a run with a contract present exactly as before, require-frozen on or off", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-skipped-"));
    mkdirSync(join(dir, STATE_DIR), { recursive: true });
    writeFileSync(join(dir, STATE_DIR, "intent-contract.yaml"), FROZEN_CONTRACT, "utf8");
    for (const requireFrozen of [true, false]) {
      const result = checkGate(dir, { requireFrozen, signals: { changedPaths: ["README.md"] } });
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect("skipReason" in result).toBe(false);
      expect(result.contractFound).toBe(true);
      expect(result.drift?.action).toBe("proceed");
    }
  });
});
