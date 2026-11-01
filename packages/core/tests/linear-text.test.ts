import { describe, it, expect } from "vitest";
import {
  matchAtxHeading,
  matchBoldHeading,
  matchBoldLabel,
  slashFragmentMatches,
  stripTrailingColon,
  stripTrailingParenthetical,
  trimTrailing,
} from "../src/linear-text.js";
import { NEW_CLAUSE_PROHIBITION_RE } from "../src/extract.js";

// Differential tests: each linear scanner against the regular expression it
// replaced, on generated strings short enough that the old pattern's
// backtracking does not matter. The alphabets carry every character the
// patterns treat specially, plus line terminators ("." does not match them
// and "\s" does) and non-ASCII whitespace ("\s" matches it).
//
// Every non-ASCII character is written as a code point so it is visible in
// review.
const LS = String.fromCharCode(0x2028); // LINE SEPARATOR, a line terminator
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR, a line terminator
const NBSP = String.fromCharCode(0x00a0); // NO-BREAK SPACE, whitespace only
const BOM = String.fromCharCode(0xfeff); // ZERO WIDTH NO-BREAK SPACE, whitespace only
const IDEO = String.fromCharCode(0x3000); // IDEOGRAPHIC SPACE, whitespace only
const SPECIAL_SPACE = ["\n", "\r", LS, PS, NBSP, BOM, IDEO];

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(alphabet: string[], count: number, maxLength: number, seed: number): string[] {
  const random = prng(seed);
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = Math.floor(random() * (maxLength + 1));
    let text = "";
    for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
    out.push(text);
  }
  return out;
}

const COUNT = 20_000;

describe("linear scanners match the patterns they replaced", () => {
  it("trimTrailing is text.replace(/[chars]+$/, '')", () => {
    const alphabet = [".", ",", ";", ":", "!", "?", "/", "a", " ", "\t", ...SPECIAL_SPACE];
    for (const text of generate(alphabet, COUNT, 12, 1)) {
      expect(trimTrailing(text, ".,;:!?"), JSON.stringify(text)).toBe(text.replace(/[.,;:!?]+$/, ""));
      expect(trimTrailing(text, "/"), JSON.stringify(text)).toBe(text.replace(/\/+$/, ""));
      expect(trimTrailing(text, ",:;.", true), JSON.stringify(text)).toBe(
        text.replace(/[,:;.\s]+$/, ""),
      );
      expect(trimTrailing(text, "`'\")>],;:!?"), JSON.stringify(text)).toBe(
        text.replace(/[`'")>\],;:!?]+$/, ""),
      );
    }
  });

  it("slashFragmentMatches is the fragment pattern's matchAll", () => {
    const alphabet = ["a", "Z", "0", ".", "_", "-", "/", "/", " ", "!", "\\", ...SPECIAL_SPACE];
    const pattern = /[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)+/g;
    for (const text of generate(alphabet, COUNT, 16, 2)) {
      const expected = [...text.matchAll(pattern)].map((m) => m[0]);
      expect(slashFragmentMatches(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it("stripTrailingParenthetical and stripTrailingColon are the headingKey replaces", () => {
    const alphabet = ["(", ")", ":", "a", " ", "\t", "(", ...SPECIAL_SPACE];
    for (const text of generate(alphabet, COUNT, 12, 3)) {
      expect(stripTrailingParenthetical(text), JSON.stringify(text)).toBe(
        text.replace(/\s*\([^)]*\)\s*$/, ""),
      );
      expect(stripTrailingColon(text), JSON.stringify(text)).toBe(text.replace(/\s*:\s*$/, ""));
    }
  });

  it("matchAtxHeading is /^(#{1,6})\\s+(.+?)\\s*#*\\s*$/", () => {
    const pattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    const alphabet = ["#", "#", "#", " ", " ", "\t", "a", "b", ...SPECIAL_SPACE];
    for (const text of generate(alphabet, COUNT * 2, 14, 4)) {
      const m = text.match(pattern);
      const expected = m ? { hashes: m[1], title: m[2] } : null;
      expect(matchAtxHeading(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it("matchBoldHeading is /^(\\*\\*|__)(.+?)\\1\\s*:?\\s*$/", () => {
    const pattern = /^(\*\*|__)(.+?)\1\s*:?\s*$/;
    const alphabet = ["*", "*", "_", ":", " ", "\t", "a", ...SPECIAL_SPACE];
    const inputs = generate(alphabet, COUNT * 2, 12, 5).flatMap((t) => [t, `**${t}`, `__${t}`]);
    for (const text of inputs) {
      const m = text.match(pattern);
      const expected = m ? { delimiter: m[1], title: m[2] } : null;
      expect(matchBoldHeading(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it("matchBoldLabel is /^(\\*\\*|__)(.+?)\\1\\s*:?\\s+(.+)$/", () => {
    const pattern = /^(\*\*|__)(.+?)\1\s*:?\s+(.+)$/;
    const alphabet = ["*", "*", "_", ":", " ", " ", "\t", "a", ...SPECIAL_SPACE];
    const inputs = generate(alphabet, COUNT * 2, 12, 6).flatMap((t) => [t, `**${t}`, `__${t}`]);
    for (const text of inputs) {
      const m = text.match(pattern);
      const expected = m ? { delimiter: m[1], label: m[2], rest: m[3] } : null;
      expect(matchBoldLabel(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it("NEW_CLAUSE_PROHIBITION_RE captures what the old pattern did on trimmed parts", () => {
    const old =
      /^(?:and|or)\s+(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no)\s+(.+)$/i;
    const words = ["or", "and", "no", "never", "do not", "x", " ", "  ", "\t", "y z", ...SPECIAL_SPACE];
    // The caller trims every part before matching, so the inputs are trimmed.
    for (const raw of generate(words, COUNT, 6, 7)) {
      const text = raw.trim();
      const before = text.match(old);
      const after = text.match(NEW_CLAUSE_PROHIBITION_RE);
      expect(after?.slice(1) ?? null, JSON.stringify(text)).toEqual(before?.slice(1) ?? null);
    }
  });

  it("NEW_CLAUSE_PROHIBITION_RE is linear on a long run of spaces before a line separator", () => {
    const text = `or no ${" ".repeat(50_000)}x${LS}y`;
    const start = performance.now();
    expect(text.match(NEW_CLAUSE_PROHIBITION_RE)).toBeNull();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
