// Drift check for the load-bearing hardening in action.yml.
//
// The install suite runs the step and checks what npm was asked. That can
// stay green while the source of the step drifts: a second, weaker copy of
// the version shape, a floor comment that no longer matches the comparison,
// or an install that dropped --ignore-scripts and grew a lookalike later.
// This file reads the workflow text and pins the lines that actually run.
// A phrase that also appears in a comment is not a pin.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const actionYml = readFileSync(path.join(ROOT, "action.yml"), "utf8");

const VERSION_SHAPE = String.raw`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`;
const VERSION_SHAPE_LINE = `if [[ ! "\${IG_VERSION}" =~ ${VERSION_SHAPE} ]]; then`;
const VERSION_SHAPE_LINE_COUNT = 2;

// Each entry is one whole line of a step's `run:` script, trimmed.
const PINS = [
  // The npm signature floor, 10.5.2, and the sentence that names it.
  'if [ "${NPM_MAJOR}" -gt 10 ] 2>/dev/null; then',
  'elif [ "${NPM_MAJOR}" -eq 10 ] 2>/dev/null; then',
  'if [ "${NPM_MINOR}" -gt 5 ] 2>/dev/null; then',
  'elif [ "${NPM_MINOR}" -eq 5 ] 2>/dev/null && [ "${NPM_PATCH}" -ge 2 ] 2>/dev/null; then',
  "printf '::error::intent-guard: npm %s cannot verify package signatures. This action needs npm 10.5.2 or newer; below that npm reports valid packages as tampered with, because its own bundled keys are stale.\\n' \"${NPM_VERSION}\"",
  // The Node remediation the floor prints.
  "printf '::error::Pin a Node release carrying a newer npm. Node 20.13.0 and later, and 22.1.0 and later, are fine; 22.0.0 ships npm 10.5.1 and is not. Or pin vaultcompasshq/intent-guard@v1.5.2, which does not verify.\\n'",
  // The install never runs a lifecycle script.
  'npm install -g --ignore-scripts "@vaultcompass/intent-guard@${IG_VERSION}"',
  // Signatures are audited from the install prefix, in a subshell.
  '( cd "${npm_config_prefix}/lib" && npm audit signatures )',
  // The scanner tag a pull request is compared against.
  "IG_TAG_SCANNER_MAJOR=1",
  "IG_TAG_SCANNER_MINOR=8",
  "IG_TAG_SCANNER_PATCH=0",
];

// The lines that run: every step's `run:` script, split into lines, trimmed,
// with blank lines and shell comments dropped. Text anywhere else in the file
// (an input description, a YAML comment) is not a line that runs.
function runLines(text) {
  const parsed = parse(text);
  return (parsed?.runs?.steps ?? [])
    .flatMap((step) => (typeof step.run === "string" ? step.run.split("\n") : []))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// The pins this text no longer carries as a line that runs, and the count of
// executable version-shape lines when it is not the expected one.
function missingPins(text) {
  const lines = runLines(text);
  const missing = PINS.filter((pin) => !lines.includes(pin));
  const shapeCount = lines.filter((line) => line === VERSION_SHAPE_LINE).length;
  if (shapeCount !== VERSION_SHAPE_LINE_COUNT) missing.push(`version shape x${shapeCount}`);
  return missing;
}

// The real line turned into a commented copy of itself, in place: the text
// still contains every word of the pin, but nothing runs it.
function commentOut(text, line) {
  const at = text.split("\n").findIndex((candidate) => candidate.trim() === line);
  if (at === -1) throw new Error(`action.yml has no line ${line}`);
  const lines = text.split("\n");
  const indent = lines[at].match(/^\s*/)[0];
  lines[at] = `${indent}# ${line}`;
  return lines.join("\n");
}

describe("action.yml hardening drift check", () => {
  it("carries every pinned line as a line that runs", () => {
    expect(missingPins(actionYml)).toEqual([]);
  });

  for (const pin of PINS) {
    it(`goes red when this line is replaced by a commented copy: ${pin.slice(0, 60)}`, () => {
      expect(missingPins(commentOut(actionYml, pin))).toContain(pin);
    });
  }

  it("goes red when one of the version-shape lines is replaced by a commented copy", () => {
    expect(missingPins(commentOut(actionYml, VERSION_SHAPE_LINE))).toContain("version shape x1");
  });

  it("goes red when the version-shape line gains a third copy", () => {
    const extra = actionYml.replace(
      `        ${VERSION_SHAPE_LINE}`,
      `        ${VERSION_SHAPE_LINE}\n          :\n        fi\n        ${VERSION_SHAPE_LINE}`,
    );
    expect(missingPins(extra)).toContain("version shape x3");
  });
});
