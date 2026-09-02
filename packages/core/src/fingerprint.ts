import { createHash } from "node:crypto";

/**
 * Recipe version. It is part of the hashed input, so bumping it deliberately
 * invalidates every previously recorded fingerprint. Bump it only when the
 * canonical form genuinely has to change, and treat that as a breaking change
 * for anything holding stored ids (a baseline file, the umbrella's dedupe).
 */
export const FINGERPRINT_RECIPE = "intent-guard.finding.v1";

export interface FindingFingerprintInput {
  /** The contract the finding was raised against. */
  contractId: string;
  /** The rule or category that produced it, e.g. "protected_paths". */
  ruleId: string;
  /** The paths or tokens the finding is about. Order does not matter. */
  matched: string[];
}

/**
 * Normalize one matched entry so that two spellings of the same thing hash the
 * same: trim surrounding whitespace, use forward slashes so a finding is the
 * same finding on Windows, and drop a leading "./" so a contract glob and a
 * git path agree.
 */
function normalize(entry: string): string {
  return entry.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Sorted, deduplicated, in codepoint order. Codepoint order rather than
 * localeCompare, because localeCompare depends on the machine's locale and the
 * whole point of a fingerprint is that two machines agree.
 */
function canonicalMatched(matched: string[]): string[] {
  const seen = new Set<string>();
  for (const entry of matched) {
    const normalized = normalize(entry);
    if (normalized !== "") seen.add(normalized);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Length-prefix each field. Joining fields with a separator would let content
 * move across a field boundary and collide: ("ab", "c") and ("a", "bc") hash
 * the same under a plain join. A length prefix makes the encoding
 * unambiguous, and no separator character has to be assumed absent from a path.
 */
function field(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * A deterministic id for one finding: sha256, hex, of a canonical string built
 * from the contract id, the rule or category id, and the sorted normalized
 * matched set. Nothing positional and nothing time-based goes in, so the same
 * finding on the same input hashes the same on every run and every machine,
 * whatever order the findings came out in and whatever order git listed the
 * paths.
 *
 * Deliberately excluded, and why:
 *   - the finding's index or position in the list: reordering findings is not
 *     a new finding;
 *   - timestamps and run ids: the same problem found tomorrow is the same
 *     problem;
 *   - scores, severities, and human message text: those are the tool's current
 *     opinion about a finding, and they change as the rubric and the wording
 *     change. An id that moved when a message was reworded would break every
 *     baseline on a copy edit.
 *
 * The full recipe is documented in docs/cli-reference.md so the umbrella and
 * any baseline tooling can reproduce it without reading this file.
 */
export function findingFingerprint(input: FindingFingerprintInput): string {
  const matched = canonicalMatched(input.matched);
  const canonical = [
    field(FINGERPRINT_RECIPE),
    field(input.contractId),
    field(input.ruleId),
    field(String(matched.length)),
    ...matched.map(field),
  ].join("");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
