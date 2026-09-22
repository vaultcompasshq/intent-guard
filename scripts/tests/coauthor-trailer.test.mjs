// The CI step that refuses a bot co-author trailer is inline bash. This
// pins the pattern it uses, so a planted trailer still matches after an
// edit of the workflow, and a message with no trailer does not.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

const PATTERN_LINE =
  "pattern='^Co-authored-by:.*(cursoragent@cursor\\.com|noreply@anthropic\\.com|\\[bot\\])'";

function trailerPattern() {
  const match = ci.match(/pattern='(\^Co-authored-by:.*)'/);
  expect(match).not.toBeNull();
  return new RegExp(match[1], "i");
}

describe("CI bot co-author refusal", () => {
  it("keeps the refusal step and its pattern", () => {
    expect(ci).toContain("Refuse pull requests with bot co-author trailers");
    expect(ci).toContain(PATTERN_LINE);
  });

  it("refuses a planted Cursor co-author trailer and accepts a clean message", () => {
    const pattern = trailerPattern();
    const planted = "Fix the gate.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n";
    expect(planted.split("\n").some((line) => pattern.test(line))).toBe(true);
    const clean = "Fix the gate.\n\nNo trailer on this commit.\n";
    expect(clean.split("\n").some((line) => pattern.test(line))).toBe(false);
  });
});
