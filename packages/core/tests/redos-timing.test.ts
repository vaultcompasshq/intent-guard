import { describe, it, expect } from "vitest";
import { slashJoinedFragments } from "../src/tokenize.js";
import { suggestPathBudgets } from "../src/path-suggestions.js";
import { matchesGlob } from "../src/budget.js";
import { draftContract, isLabelledScopeHeading, segmentForExtraction } from "../src/extract.js";

// Each input below is shaped after a CodeQL js/polynomial-redos alert: a long
// run of the character the alert names, placed so the pattern has to fail.
// Measured on the code before the fix, these took 1 to 8 seconds at 50000
// characters, and the two heading inputs took about 25 seconds at only 5000
// (cubic), so at 50000 they do not finish. After the fix each is a single
// linear pass of a few milliseconds. The limit is set well above that so a
// slow CI runner does not trip it, and well below the pre-fix times. The text
// a gate reads comes from a diff or a file an agent wrote, so it is
// untrusted, and a gate that hangs on it can be switched off from outside.
const N = 50_000;
const LIMIT_MS = 2000;
// U+2028 LINE SEPARATOR, written as a code point so it is visible in review.
const LS = String.fromCharCode(0x2028);

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("linear-time text scanning on adversarial input", () => {
  it("slashJoinedFragments on a long run of '-' with no slash (tokenize.ts fragment scan)", () => {
    expect(elapsed(() => slashJoinedFragments("-".repeat(N)))).toBeLessThan(LIMIT_MS);
  });

  it("slashJoinedFragments on a segment with a long run of '.' before its end (tokenize.ts segment trim)", () => {
    expect(elapsed(() => slashJoinedFragments(`a/${".".repeat(N)}a`))).toBeLessThan(LIMIT_MS);
  });

  it("suggestPathBudgets on a token with a long run of '!' before its end (path-suggestions.ts)", () => {
    expect(elapsed(() => suggestPathBudgets(`a${"!".repeat(N)}a`))).toBeLessThan(LIMIT_MS);
  });

  it("matchesGlob on a glob with a long run of '/' before its end (budget.ts)", () => {
    expect(elapsed(() => matchesGlob("src/a", `a${"/".repeat(N)}a`))).toBeLessThan(LIMIT_MS);
  });

  it("heading key on a long run of spaces (extract.ts headingKey, trailing colon and parenthetical)", () => {
    expect(elapsed(() => isLabelledScopeHeading(`a${" ".repeat(N)}x`))).toBeLessThan(LIMIT_MS);
  });

  it("heading key on a long run of '(' (extract.ts headingKey, trailing parenthetical)", () => {
    expect(elapsed(() => isLabelledScopeHeading("(".repeat(N)))).toBeLessThan(LIMIT_MS);
  });

  it("an ATX heading line with a long run of spaces before its last word (extract.ts)", () => {
    expect(elapsed(() => segmentForExtraction(`# a${" ".repeat(N)}x${LS}y`))).toBeLessThan(LIMIT_MS);
  });

  it("a bold line with a long run of spaces after the closing marker (extract.ts bold heading and label)", () => {
    expect(elapsed(() => segmentForExtraction(`**a**${" ".repeat(N)}x${LS}y`))).toBeLessThan(LIMIT_MS);
  });

  it("a bullet item with a long run of ', ' before its end (extract.ts normalizeItem)", () => {
    expect(
      elapsed(() => draftContract({ userText: `- Add the parser${", ".repeat(N / 2)}x\n` })),
    ).toBeLessThan(LIMIT_MS);
  });
});
