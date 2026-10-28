// The explicit prohibition markers a Gherkin line is kept for by import-spec
// (spec-bridge.ts), and the normalisation applied before matching them. A
// kept line is routed to out_of_scope by being emitted under an Out of scope
// heading, so extraction never has to re-read these markers to route it.
// Through the first 1.10.x fix round the keep and extraction each had their
// own list, and they disagreed on a don't written with a curly apostrophe:
// the keep accepted the line, extraction did not read it as a prohibition,
// and it landed in in_scope, where its tokens cancelled a real Non-goal.

/**
 * The explicit markers, in normal form: lower case, a straight apostrophe,
 * one space between words. "must never" is covered by "never".
 */
export const EXPLICIT_PROHIBITION_MARKERS = ["shall not", "must not", "never", "do not", "don't"] as const;

// Left and right single quotation marks and the modifier-letter apostrophe
// (U+2018, U+2019, U+02BC), built from code points so this file stays ASCII.
const CURLY_APOSTROPHE_RE = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc)}]`, "g");

/**
 * Text in the form the markers are written in: curly and modifier
 * apostrophes become a straight one, and every run of whitespace (a tab, a
 * double space, a no-break space) becomes one space. Matching is
 * case-insensitive, so case is left alone.
 */
export function normalizeMarkerText(text: string): string {
  return text.replace(CURLY_APOSTROPHE_RE, "'").replace(/\s+/g, " ");
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source for the markers as alternatives, for building larger patterns. */
export const EXPLICIT_PROHIBITION_SOURCE = EXPLICIT_PROHIBITION_MARKERS.map(escapeForRegExp).join("|");

/** An explicit marker anywhere in normalised text, as a whole word or phrase. */
export const EXPLICIT_PROHIBITION_RE = new RegExp(`\\b(?:${EXPLICIT_PROHIBITION_SOURCE})\\b`, "i");

/**
 * Markers 1.9.0 read as a prohibition on a Gherkin line that the keep does
 * not accept: an expected outcome ("Then the user cannot see the button") is
 * far more often written this way than a rule, so such a line is not
 * imported, but import-spec warns about it. "no" and "without" are not here:
 * they open most negative outcomes ("Then no file is downloaded") and a
 * warning on each would bury the ones that matter. Matched on normalised
 * text, case-insensitive.
 */
export const SOFT_PROHIBITION_RE = /\b(?:should not|shouldn't|cannot|can't|avoid)\b/i;

/** True when `text`, normalised, carries an explicit prohibition marker. */
export function hasExplicitProhibition(text: string): boolean {
  return EXPLICIT_PROHIBITION_RE.test(normalizeMarkerText(text));
}
