import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkGate } from "../src/gate.js";
import { INIT_NEXT_STEPS } from "../src/init.js";

function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-gate-messages-"));
}

/**
 * The gate's blocked message is the first thing a new user reads, and for many
 * it is the only Intent Guard output they will ever see. If it names a binary
 * this release deleted, the very first instruction the tool gives is one that
 * cannot work.
 */
describe("gate guidance never names a removed binary", () => {
  it("tells a first-run user to run intent-guard binaries, not conductor ones", () => {
    const result = checkGate(emptyProject(), { requireFrozen: true });

    expect(result.status).toBe("blocked");
    expect(result.reasons.length).toBeGreaterThan(0);

    const message = result.reasons.join("\n");
    // The substring, not a whole word: conductor-extract, conductor-freeze and
    // every other removed bin start with it.
    expect(message).not.toContain("conductor-");
    expect(message).toContain("intent-guard-extract");
    expect(message).toContain("intent-guard-freeze");
    // The state directory moved in 1.3.0, and the message points at the new one.
    expect(message).toContain(".intent-guard/intent-contract.yaml");
    expect(message).not.toContain(".conductor/");
  });

  it("keeps every gate reason free of removed binary names", () => {
    // An unfrozen contract takes a different branch to a different reason.
    const dir = emptyProject();
    const missing = checkGate(dir, { requireFrozen: true });
    const notRequired = checkGate(dir, { requireFrozen: false });

    for (const reason of [...missing.reasons, ...notRequired.reasons]) {
      expect(reason).not.toContain("conductor-");
    }
  });

  it("keeps the init next-steps free of removed binary names", () => {
    // Same failure mode, same audience: this is what init prints on success.
    for (const step of INIT_NEXT_STEPS) {
      expect(step).not.toContain("conductor-");
      expect(step).not.toMatch(/(^|\s)conductor\s/);
    }
  });
});
