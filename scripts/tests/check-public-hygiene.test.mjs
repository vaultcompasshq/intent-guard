// Proves the dash rule on a planted character. The character is built from
// its code point so this file does not itself contain one: the guard scans
// every tracked file, including this test.

import { describe, expect, it } from "vitest";

import { scanFile } from "../check-public-hygiene.mjs";

describe("check-public-hygiene dash rule", () => {
  it("fails a planted em dash, including in an allowlisted file", () => {
    const emDash = String.fromCodePoint(0x2014);
    const text = `line one\nline two has an ${emDash} dash\n`;
    expect(scanFile("CONTRIBUTING.md", text, { allowlisted: true, bannedHashes: new Set() })).toEqual([
      "CONTRIBUTING.md:2: em/en dash (non-ASCII) in tracked file",
    ]);
  });

  it("fails a planted en dash", () => {
    const enDash = String.fromCodePoint(0x2013);
    const text = `range 2${enDash}4\n`;
    expect(scanFile("fixture.md", text, { allowlisted: false, bannedHashes: new Set() })).toEqual([
      "fixture.md:1: em/en dash (non-ASCII) in tracked file",
    ]);
  });
});
