import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkGate } from "../src/gate.js";
import { STATE_DIR } from "../src/state-dir.js";

/**
 * The vacuous-scan question, settled for intent-guard.
 *
 * A sibling gate in this org once passed a whole-tree scan that examined ZERO
 * files: a green check that had established nothing read as coverage, so it was
 * changed to could-not-run. The question here is whether intent-guard has the
 * same hole, and the answer these tests pin is that it does not, because a
 * green pass structurally REQUIRES a resolved, frozen contract. The emptiness
 * that would matter is discovered at contract resolution, upstream of scope,
 * and it already fails closed.
 *
 * Three states, not two. The last two look alike from the outside (the scan
 * touched nothing the contract governs) and must NOT be conflated:
 *
 *   (a) IMPOSED empty scope   -- nothing changed on the branch. Clean.
 *   (b) DISCOVERED empty      -- pointed at a root with no contract, even
 *                                though the diff is non-empty. Fails closed.
 *   (c) LEGITIMATE clean      -- a resolved contract the diff simply does not
 *                                touch the governed scope of. Clean.
 *
 * The load-bearing signal that separates (b) from (c) is `contractFound`: (b)
 * is contractFound === false (the contract did not resolve), (c) is
 * contractFound === true with an empty scope intersection. A check that keyed
 * could-not-run on "zero in-scope changed paths" would fire on (c) and red
 * every unrelated pull request; that is why intent-guard does not add one.
 */

/** A frozen contract whose only budget rule governs the payment module. */
const CONTRACT = `contract_id: ic-20260918-aaaaaa
version: 1.0.0
original_ask: Update the readme usage docs and nothing else.
in_scope:
  - Update the README usage documentation
out_of_scope:
  - Changes to the payment module
constraints:
  - source: user-stated
    rule: Do not touch the payment module
    priority: critical
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-18T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-18T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  protected_paths:
    - "**/payment/**"
`;

/** A temp project with a frozen contract on disk at the resolved state dir. */
function projectWithContract(): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-empty-scope-"));
  mkdirSync(join(dir, STATE_DIR), { recursive: true });
  writeFileSync(join(dir, STATE_DIR, "intent-contract.yaml"), CONTRACT, "utf8");
  return dir;
}

/** A temp project with no contract at all -- a wrong or unconfigured root. */
function bareProject(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-empty-scope-bare-"));
}

describe("(a) an imposed empty scope stays clean", () => {
  it("passes when a frozen contract exists and nothing changed", () => {
    const dir = projectWithContract();

    // The shape a workflow sends when the diff is empty: the empty set is
    // stated, not withheld.
    const result = checkGate(dir, {
      requireFrozen: true,
      signals: { changedPaths: [] },
    });

    expect(result.contractFound).toBe(true);
    expect(result.contractFrozen).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    // Nothing changed, so nothing was scored -- and that is a clean pass, not a
    // could-not-run.
    expect(result.reasons).toEqual([]);
  });

  it("passes with no drift inputs supplied at all", () => {
    const dir = projectWithContract();

    const result = checkGate(dir, { requireFrozen: true });

    expect(result.contractFound).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });
});

describe("(b) a discovered empty scope fails closed", () => {
  it("blocks a NON-empty diff when no contract resolves at the root", () => {
    const dir = bareProject();

    // The diff is non-empty; the contract is what is missing. A whole-tree
    // sibling would have called this a clean scan of a tree it never read. The
    // intent gate refuses it, because a green pass requires a contract and
    // there is none here.
    const result = checkGate(dir, {
      requireFrozen: true,
      signals: { changedPaths: ["src/app/payment/charge.ts", "README.md"] },
    });

    expect(result.contractFound).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("distinguishes itself from (c) by contractFound, not by scope size", () => {
    // The whole point: (b) and (c) can carry the very same changed set. What
    // separates them is whether the contract resolved, and nothing else.
    const sameDiff = { changedPaths: ["README.md"] };

    const discovered = checkGate(bareProject(), {
      requireFrozen: true,
      signals: sameDiff,
    });
    const legitimate = checkGate(projectWithContract(), {
      requireFrozen: true,
      signals: sameDiff,
    });

    expect(discovered.contractFound).toBe(false);
    expect(discovered.status).toBe("blocked");

    expect(legitimate.contractFound).toBe(true);
    expect(legitimate.status).toBe("ok");
  });
});

describe("(c) a legitimate out-of-scope diff is a clean pass, not could-not-run", () => {
  it("passes a non-empty diff that touches nothing the contract governs", () => {
    const dir = projectWithContract();

    // README.md is real, changed, and outside the contract's only governed
    // scope (**/payment/**). This is the case a naive empty-scan check would
    // false-red. It must stay green.
    const result = checkGate(dir, {
      requireFrozen: true,
      signals: { changedPaths: ["README.md"] },
    });

    expect(result.contractFound).toBe(true);
    expect(result.contractFrozen).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.reasons).toEqual([]);
    // The budget ran and found nothing to enforce here -- an ok result over a
    // real diff, which is exactly "nothing to enforce", not "nothing scanned".
    expect(result.budget?.ok).toBe(true);
  });

  it("still blocks the same contract when the diff DOES hit the governed scope", () => {
    // The counterweight: (c) staying green is only correct because the gate
    // still bites when the diff reaches the protected scope. Without this, a
    // permanently-green (c) would be indistinguishable from a broken gate.
    const dir = projectWithContract();

    const result = checkGate(dir, {
      requireFrozen: true,
      signals: { changedPaths: ["src/app/payment/charge.ts"] },
    });

    expect(result.contractFound).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.budget?.action).toBe("hard_block");
  });
});
