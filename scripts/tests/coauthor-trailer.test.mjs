// The CI step that refuses a bot co-author trailer is inline bash. This
// pins the pattern on the executable line, so a comment that copies the
// strong pattern cannot keep the check green after the line CI actually
// greps is weakened.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

const PATTERN_LINE =
  "pattern='^Co-authored-by:.*(cursoragent@cursor\\.com|noreply@anthropic\\.com|\\[bot\\])'";

function codeLines(text) {
  return text.split("\n").filter((line) => !line.trim().startsWith("#"));
}

function executablePatternLine(text) {
  const hits = codeLines(text)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("pattern='^Co-authored-by:"));
  expect(hits).toHaveLength(1);
  return hits[0];
}

function trailerPattern(text) {
  const match = executablePatternLine(text).match(/^pattern='(\^Co-authored-by:.*)'$/);
  expect(match).not.toBeNull();
  return new RegExp(match[1], "i");
}

describe("CI bot co-author refusal", () => {
  it("keeps the refusal step and the executable pattern", () => {
    expect(
      codeLines(ci).some((line) => line.includes("Refuse pull requests with bot co-author trailers")),
    ).toBe(true);
    expect(executablePatternLine(ci)).toBe(PATTERN_LINE);
  });

  it("refuses planted bot trailers and accepts a clean message", () => {
    const pattern = trailerPattern(ci);
    const planted = [
      "Co-authored-by: Cursor <cursoragent@cursor.com>",
      "Co-authored-by: Claude <noreply@anthropic.com>",
      "Co-authored-by: dependabot[bot] <dependabot[bot]@users.noreply.github.com>",
    ];
    for (const line of planted) {
      expect(pattern.test(line)).toBe(true);
    }
    expect(pattern.test("No trailer on this commit.")).toBe(false);
  });
});
