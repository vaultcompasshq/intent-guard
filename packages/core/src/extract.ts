import type {
  AcceptanceCriterion,
  Constraint,
  IntentContract,
} from "@vaultcompass/intent-guard-schema";
import { scorePrompt } from "./coach.js";
import { constraintRuleTexts, dedupeRules, type RuleReplacement } from "./constraints.js";

export interface DraftContractInput {
  userText: string;
  constraints?: Constraint[];
  /**
   * The text original_ask is built from, when it is not the whole userText.
   * import-spec passes its one-line header, so the spec body is never copied
   * into original_ask (where drift would read all of it as agreed scope).
   */
  ask?: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0").slice(0, 6);
}

export function generateContractId(date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `ic-${ymd}-${randomSuffix()}`;
}

// A '.', '!' or '?' terminates a sentence only when followed by whitespace or
// end of input -- except a '.' that closes a simple filename extension (e.g.
// ".ts.", ".yaml.") before the next sentence. Compound extensions (".test.ts.",
// ".spec.tsx.", ".d.ts.") still end the sentence at the final dot.
const SIMPLE_FILE_EXTENSION_SUFFIX = /\.\w{1,8}$/;
const COMPOUND_FILE_EXTENSION_SUFFIX = /\.[a-z0-9][\w-]*\.[a-z]{2,8}$/i;

function isFilenameExtensionPeriod(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if (COMPOUND_FILE_EXTENSION_SUFFIX.test(before)) return false;
  return SIMPLE_FILE_EXTENSION_SUFFIX.test(before);
}

function isSentenceTerminatorAt(text: string, index: number): boolean {
  const ch = text[index];
  if (!/[.!?]/.test(ch)) return false;
  const rest = text.slice(index + 1);
  if (rest.length > 0 && !/^\s/.test(rest)) return false;
  if (ch === "." && isFilenameExtensionPeriod(text, index)) return false;
  return true;
}

function findFirstSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isSentenceTerminatorAt(text, i)) return i;
  }
  return -1;
}

function oneSentence(text: string, max = 500): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const boundary = findFirstSentenceEnd(normalized);
  const sentence = (boundary === -1
    ? normalized
    : normalized.slice(0, boundary + 1)
  ).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** The longest original_ask a draft carries: the contract schema's own maxLength. */
export const ORIGINAL_ASK_MAX = 500;
const ELLIPSIS = " ...";

/**
 * The whole ask, whitespace-normalised. Through 1.9.0 this kept only the
 * first sentence, so a reviewer freezing the draft never saw the rest of
 * what was asked. An ask longer than ORIGINAL_ASK_MAX keeps as many whole
 * sentences as fit and ends with " ..."; only a first sentence that alone is
 * too long is cut, at a word boundary.
 */
export function wholeAsk(text: string, max = ORIGINAL_ASK_MAX): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const budget = max - ELLIPSIS.length;
  let cut = -1;
  for (let i = 0; i < budget; i++) {
    if (isSentenceTerminatorAt(normalized, i)) cut = i + 1;
  }
  if (cut > 0) return `${normalized.slice(0, cut)}${ELLIPSIS}`;
  const head = normalized.slice(0, budget + 1);
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head.slice(0, budget)).trimEnd()}${ELLIPSIS}`;
}

// A prohibition marker anywhere in a sentence: "not" covers do not, must
// not, should not, shall not and will not.
const ANY_PROHIBITION_MARKER_RE =
  /\b(?:no|not|never|don't|dont|cannot|can't|won't|mustn't|shouldn't|avoid)\b/i;

/**
 * The sentences of an ask that describe work to do: every sentence with no
 * prohibition marker anywhere in it. Drift subtracts these tokens as agreed
 * scope, so a sentence that forbids something ("Keep the change small and
 * never touch billing", "Then, do not modify billing") must not cancel the
 * out_of_scope item it produced. Drift also never subtracts an ask token
 * that an out_of_scope item or a constraint uses (see drift.ts).
 */
export function askScopeSentences(ask: string): string[] {
  return splitSentences(ask).filter((sentence) => !ANY_PROHIBITION_MARKER_RE.test(sentence));
}

// Split into sentence-like segments without breaking dotted file tokens or
// treating ".ts." / ".yaml." as a sentence boundary.
function splitSentences(text: string): string[] {
  const segments: string[] = [];

  for (const line of text.split(/\n+/)) {
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      if (!isSentenceTerminatorAt(line, i)) continue;
      const chunk = line.slice(start, i + 1).trim();
      if (chunk) segments.push(chunk);
      start = i + 1;
      while (start < line.length && /\s/.test(line[start]!)) start++;
      i = start - 1;
    }
    const tail = line.slice(start).trim();
    if (tail) segments.push(tail);
  }

  return segments
    .flatMap((chunk) => chunk.split(";"))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function bulletItems(text: string): string[] {
  const fromBullets = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length >= 5 && l.length <= 200);
  if (fromBullets.length > 0) return fromBullets.slice(0, 12);
  return [];
}

const ACTION_VERBS = [
  "add",
  "archive",
  "block",
  "build",
  "compare",
  "create",
  "detect",
  "display",
  "enable",
  "enforce",
  "export",
  "extract",
  "fix",
  "generate",
  "hide",
  "implement",
  "include",
  "load",
  "persist",
  "preserve",
  "record",
  "redirect",
  "regenerate",
  "render",
  "show",
  "support",
  "update",
  "use",
  "validate",
  "wire",
];

const ACTION_RE = new RegExp(`\\b(${ACTION_VERBS.join("|")})\\b`, "i");
const ACTION_START_RE = new RegExp(
  `\\b(?:and|then|also|plus)?\\s*(${ACTION_VERBS.join("|")})\\b`,
  "i",
);
const PROHIBITION_RE =
  /\b(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no\s+(?!\S*-)|without)\b/i;

function normalizeItem(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .replace(/^(and|then|also|plus)\s+/i, "")
    .trim()
    .replace(/[,:;.\s]+$/, "");
}

function uniqueItems(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = normalizeItem(raw);
    const key = item.toLowerCase();
    if (item.length < 5 || item.length > 200 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function textClauses(text: string): string[] {
  return splitSentences(text)
    .flatMap((segment) =>
      segment.split(
        new RegExp(
          `\\s+(?:and|then|also|plus)\\s+(?=(?:${ACTION_VERBS.join("|")})\\b)`,
          "i",
        ),
      ),
    )
    .map(normalizeItem)
    .filter(Boolean);
}

function isProhibitionClause(text: string): boolean {
  return PROHIBITION_RE.test(text);
}

/** True only when the clause *starts* as a prohibition (not embedded "no config"). */
function isLeadingProhibitionClause(text: string): boolean {
  const trimmed = text.trim();
  return /^(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no)\b/i.test(
    trimmed,
  );
}

interface ParsedClause {
  imperatives: string[];
  prohibitions: string[];
}

function splitColonActionClauses(text: string): string[] {
  const idx = text.indexOf(":");
  if (idx <= 0 || idx >= text.length - 5) return [text];
  const head = text.slice(0, idx).trim();
  const tail = text.slice(idx + 1).trim();
  if (!ACTION_RE.test(head) || tail.length < 8) return [text];
  const results = [head];
  if (ACTION_RE.test(tail) || /^(redirect|route|wire|update)\b/i.test(tail)) {
    results.push(normalizeItem(tail));
  }
  return results;
}

function splitImperativeFromProhibition(clause: string): ParsedClause {
  const imperatives: string[] = [];
  const prohibitions: string[] = [];
  const prohibitionMatch = clause.match(
    /\b(do not|don't|must not|should not|shall not|cannot|can't|never|avoid)\b/i,
  );

  if (!prohibitionMatch || prohibitionMatch.index === undefined) {
    if (isLeadingProhibitionClause(clause)) {
      prohibitions.push(normalizeItem(clause));
    } else {
      for (const part of splitColonActionClauses(clause)) {
        imperatives.push(normalizeItem(part));
      }
    }
    return { imperatives, prohibitions };
  }

  if (prohibitionMatch.index < 8) {
    prohibitions.push(normalizeItem(clause));
    return { imperatives, prohibitions };
  }

  const head = clause
    .slice(0, prohibitionMatch.index)
    .trim()
    .replace(/[,:;]\s*$/, "")
    .replace(/\s+so\s+users\s*$/i, "");
  const tail = clause.slice(prohibitionMatch.index).trim();

  if (head.length >= 5 && ACTION_RE.test(head) && !isProhibitionClause(head)) {
    for (const part of splitColonActionClauses(head)) {
      imperatives.push(normalizeItem(part));
    }
  }

  if (tail.length >= 5 && isValidOutOfScopeItem(tail)) {
    prohibitions.push(normalizeItem(tail));
  } else if (imperatives.length === 0 && isProhibitionClause(clause)) {
    prohibitions.push(normalizeItem(clause));
  }

  return { imperatives, prohibitions };
}

function parseActionClauses(text: string): ParsedClause {
  const imperatives: string[] = [];
  const prohibitions: string[] = [];
  const bullets = bulletItems(text);
  const sources = bullets.length > 0 ? bullets : textClauses(text);

  for (const raw of sources) {
    const parsed = splitImperativeFromProhibition(raw);
    imperatives.push(...parsed.imperatives);
    prohibitions.push(...parsed.prohibitions);
  }

  return { imperatives, prohibitions };
}

// A comma-separated fragment that itself starts a new "and/or do not …"
// clause is an independent prohibition, not a bare object of the outer
// verb -- gluing the outer prefix onto it fabricates text that never
// appeared in the input (e.g. "do not modify do not add new agent
// capabilities").
const NEW_CLAUSE_PROHIBITION_RE =
  /^(?:and|or)\s+(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no)\s+(.+)$/i;

function sentenceContaining(text: string, index: number): string {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isSentenceTerminatorAt(text, i)) continue;
    if (index <= i) return text.slice(start, i + 1);
    start = i + 1;
  }
  return text.slice(start);
}

function isProhibitionSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (isAcceptanceCriterionClause(trimmed)) return false;
  return isLeadingProhibitionClause(trimmed) || isProhibitionClause(trimmed);
}

/**
 * A bare "A or B" after the prohibition verb. Each side is 1 to 3 words,
 * with no punctuation, parentheses, or "either". "without" is a modifier,
 * not a bare object, so "without review or approval" is not this shape.
 * Returns null when the split must not happen, including when either side
 * would be dropped by the length filter.
 */
function bareOrSides(rest: string): [string, string] | null {
  const trimmed = rest.trim();
  if (/\b(either|without)\b/i.test(trimmed)) return null;
  if (!/^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,2}\s+or\s+[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,2}$/i.test(trimmed)) {
    return null;
  }
  const [left, right] = trimmed.split(/\s+or\s+/i);
  if (!left || !right) return null;
  if (normalizeItem(left).length < 5 || normalizeItem(right).length < 5) return null;
  return [left, right];
}

function expandProhibitionLists(text: string): { items: string[]; replaced: Set<string> } {
  const items: string[] = [];
  const replaced = new Set<string>();
  const pattern =
    /\b(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no)\s+([a-z]+)\s+([^.!?]{3,200})/gi;

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1].replace(/\s+/g, " ");
    const verb = match[2];
    const rest = match[3];
    const hasCommaList = rest.includes(",");
    const sentence = sentenceContaining(text, match.index ?? 0);
    const orSides =
      !hasCommaList && isProhibitionSentence(sentence) ? bareOrSides(rest) : null;
    if (!hasCommaList && !orSides) continue;

    if (orSides) {
      for (const side of orSides) {
        items.push(`${prefix} ${verb} ${normalizeItem(side)}`);
      }
      replaced.add(normalizeItem(`${prefix} ${verb} ${rest}`).toLowerCase());
      replaced.add(normalizeItem(match[0]).toLowerCase());
      replaced.add(normalizeItem(sentence).toLowerCase());
      continue;
    }

    const parts = rest.split(",");
    for (const part of parts) {
      const trimmedPart = part.trim();
      const newClause = trimmedPart.match(NEW_CLAUSE_PROHIBITION_RE);
      if (newClause) {
        const target = normalizeItem(newClause[2]);
        if (target.length < 5) continue;
        items.push(`${newClause[1].toLowerCase()} ${target}`);
        continue;
      }
      const target = normalizeItem(trimmedPart.replace(/^(and|or)\s+/i, ""));
      if (target.length < 5) continue;
      items.push(`${prefix} ${verb} ${target}`);
    }
  }

  return { items, replaced };
}

// A clause carrying its own "Done when …" / "Verify …" / "Acceptance:"
// marker is an acceptance criterion, not a scope item, even when it
// otherwise looks imperative-shaped.
function isAcceptanceCriterionClause(text: string): boolean {
  return /^(done when|verify|acceptance:)\b/i.test(text.trim());
}

function extractInScope(text: string): string[] {
  const { imperatives } = parseActionClauses(text);
  const bullets = bulletItems(text);

  if (bullets.length > 0) {
    return uniqueItems(
      imperatives.filter((item) => !isLeadingProhibitionClause(item)),
      12,
    );
  }

  // A multi-clause "X and Y" imperative sentence only needs its *second*
  // clause to contain a recognized action verb to trigger the split (see
  // textClauses). Once split, trust every resulting clause instead of
  // re-filtering each one through the same curated verb list -- otherwise a
  // legitimate first clause phrased with an uncommon verb (e.g. "blend")
  // is silently dropped even though the split already proved this is a
  // genuine multi-part imperative sentence.
  const clauses =
    imperatives.length > 1
      ? imperatives.filter(
          (c) => !isLeadingProhibitionClause(c) && !isAcceptanceCriterionClause(c),
        )
      : imperatives.filter(
          (c) => ACTION_RE.test(c) && !isLeadingProhibitionClause(c),
        );
  if (clauses.length > 0) return uniqueItems(clauses, 8);

  const fallback = oneSentence(text, 200);
  return fallback.length >= 5 ? [fallback] : ["Describe the requested change"];
}

function extractEmbeddedProhibitions(text: string): string[] {
  const { prohibitions } = parseActionClauses(text);
  // Uncapped: draftContract ranks and applies the real cap.
  return uniqueItems(prohibitions, Number.MAX_SAFE_INTEGER);
}

function isValidOutOfScopeItem(item: string): boolean {
  const normalized = item.trim();
  if (/^without\b/i.test(normalized)) {
    return /^without\s+(approval|permission|changing|modifying|adding|removing|introducing|writing)\b/i.test(
      normalized,
    );
  }
  return /^(do not|don't|must not|should not|shall not|cannot|can't|never|avoid|no)\b/i.test(
    normalized,
  );
}

function extractOutOfScope(text: string): { items: string[]; replaced: Set<string> } {
  const tail = String.raw`[\w\s/.\-]{3,200}`;
  const patterns = [
    new RegExp(String.raw`\bdo\s+not\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bmust\s+not\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bshould\s+not\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bshall\s+not\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bcannot\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bcan't\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bnever\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bavoid\s+([a-z]${tail})`, "gi"),
    new RegExp(String.raw`\bno\s+([a-z]${tail})`, "gi"),
    new RegExp(
      String.raw`\bwithout\s+(approval|permission|changing|modifying|adding|removing|introducing|writing)\s+([a-z]${tail})`,
      "gi",
    ),
  ];
  const { items: listed, replaced } = expandProhibitionLists(text);
  const items: string[] = [...listed];
  // Match within one sentence at a time so a prohibition clause can't run
  // past its own sentence boundary into the next one (e.g. an acceptance
  // criteria "Done when..." clause), and so the capture isn't capped at a
  // fixed small character budget that truncates real-world clauses
  // mid-word -- each sentence is already correctly bounded by
  // splitSentences, including filename-extension periods.
  for (const sentence of splitSentences(text)) {
    for (const pattern of patterns) {
      for (const match of sentence.matchAll(pattern)) {
        const item = match[0].trim().replace(/\s+/g, " ");
        if (replaced.has(normalizeItem(item).toLowerCase())) continue;
        if (item.length >= 5 && item.length <= 200 && isValidOutOfScopeItem(item)) {
          items.push(item);
        }
      }
    }
  }
  // Uncapped: draftContract ranks and applies the real cap. A cap here, before
  // ranking, dropped whichever rules happened to come late in the document.
  const unique = uniqueItems(items, Number.MAX_SAFE_INTEGER);
  return {
    items: unique.filter((item, index) => {
      const key = item.toLowerCase();
      return !unique
        .slice(0, index)
        .some((previous) => previous.toLowerCase().includes(key));
    }),
    replaced,
  };
}

// ---------------------------------------------------------------------------
// Heading-aware segmentation
//
// A real spec says what it will NOT do under a "Non-goals" heading, describes
// what is broken today under "Problem" or "Background", and summarises in
// tables. Reading it as one flat run of sentences authorised the non-goals
// (their bullets became in_scope) and forbade the fix (a problem statement
// such as "CI never runs npm test" became an out_of_scope item). The rules
// below route by section before any clause is parsed. Text with no headings,
// tables or labelled lines comes through unchanged.
// ---------------------------------------------------------------------------

type SectionKind = "normal" | "out_of_scope" | "problem";

/** Lowercased heading text with numbering, emphasis, a colon and a trailing parenthetical removed. */
function headingKey(raw: string): string {
  return raw
    .replace(/[*_`]/g, "")
    .replace(/’/g, "'")
    .trim()
    .replace(/^(?:\d+(?:\.\d+)*\.?|[a-z]\.|section\s+\d+(?:\.\d+)*:?)\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*:\s*$/, "")
    .trim()
    .toLowerCase();
}

// A heading that opens a list of things the spec will not do. "Non-goals",
// "Out of scope" and "Not in scope" may carry a qualifier ("Out of scope for
// v1"); the shorter, more ambiguous words must be the whole heading, so a
// "Will not crash on empty input" requirement heading is not read as one.
const OUT_OF_SCOPE_PREFIX_RE =
  /^(?:explicit(?:ly)?\s+)?(?:non[\s-]?goals?|out[\s-]of[\s-]scope|not\s+in\s+scope)\b/;
const OUT_OF_SCOPE_EXACT_RE =
  /^(?:won't|will\s+not)(?:\s+(?:do|have|build|change|ship))?$|^(?:excluded|exclusions|deferred(?:\s+work)?|future\s+work)$/;

// A heading whose section describes the world as it is today. A bare "no X"
// or "never X" there is a finding, not a rule; an explicit prohibition there
// is still a rule (see problemClauses). Whole-heading match only, so "Context
// items" or "Background jobs" stay ordinary sections. "Introduction" is NOT
// one: every Kiro requirements.md opens with it, and its rules are real.
const PROBLEM_WORD = String.raw`(?:problem(?:\s+statement)?|problems|background|context|current\s+(?:state|failures|behaviou?r|problems|issues)|motivation)`;
const PROBLEM_HEADING_RE = new RegExp(
  String.raw`^(?:the\s+)?${PROBLEM_WORD}(?:\s+(?:and|&)\s+${PROBLEM_WORD})?$`,
);

function classifyHeading(raw: string): SectionKind | null {
  const key = headingKey(raw);
  if (OUT_OF_SCOPE_PREFIX_RE.test(key) || OUT_OF_SCOPE_EXACT_RE.test(key)) return "out_of_scope";
  if (PROBLEM_HEADING_RE.test(key)) return "problem";
  return null;
}

/**
 * The headings import-spec reads under, as a reader would name them. Each
 * stands for the spellings LABELLED_SCOPE_RE accepts.
 */
export const LABELLED_SCOPE_HEADINGS = [
  "Scope",
  "In scope",
  "Out of scope",
  "Non-goals",
  "Requirements",
  "Constraints",
  "Acceptance criteria",
  "Success criteria",
] as const;

// Scope ("Scope", "Project scope", "In scope", "Scope and non-goals"),
// requirements ("Requirements", "Functional requirements", Kiro's
// "Requirement 1: Export"; not "Requirements Document", a Kiro title that
// covers the whole file), constraints, and acceptance or success criteria.
// The out-of-scope spellings come from classifyHeading.
const LABELLED_SCOPE_RE = new RegExp(
  [
    String.raw`^(?:(?:project|feature|change|the)\s+)?scope\b`,
    String.raw`^in[\s-]scope\b`,
    String.raw`^(?:(?:functional|non[\s-]?functional|technical|user|system|security|key|core)\s+)?requirements?(?:\s+\d+(?:\.\d+)*\b.*)?$`,
    String.raw`^(?:(?:key|technical|design|hard|project)\s+)?constraints?\b`,
    String.raw`^(?:acceptance|success)\s+criteria\b`,
  ].join("|"),
);

/** Whether a heading opens a section import-spec reads. */
export function isLabelledScopeHeading(raw: string): boolean {
  return LABELLED_SCOPE_RE.test(headingKey(raw)) || classifyHeading(raw) === "out_of_scope";
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// A line that is nothing but bold text: a pseudo-heading. Nests below every
// real heading level.
const BOLD_HEADING_RE = /^(\*\*|__)(.+?)\1\s*:?\s*$/;
// A bold label followed by text on the same line: "**Out of scope:** X".
const BOLD_LABEL_RE = /^(\*\*|__)(.+?)\1\s*:?\s+(.+)$/;
// A short plain line ending in a colon: "Out of scope for this fix:".
const COLON_LABEL_RE = /^([A-Za-z][^:]{2,60}):$/;
const PSEUDO_HEADING_LEVEL = 7;
const USER_STORY_RE = /^(?:[-*+]\s+)?(?:\*\*|__)?user stor(?:y|ies)\s*:?\s*(?:\*\*|__)?\s*:?\s/i;
const TABLE_ROW_RE = /^\|.*\|$/;
const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;
const DECLARED_OUT_OF_SCOPE_RE =
  /^(?:\d+(?:\.\d+)*\.?\s+)?(.{3,120}?)\s+(?:is|are)\s+(?:explicitly\s+|deliberately\s+)?(?:out\s+of\s+scope|not\s+in\s+scope)\b/i;

/** Sentence spans of one line, without the ";" split splitSentences adds. */
function lineSentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!isSentenceTerminatorAt(line, i)) continue;
    const chunk = line.slice(start, i + 1).trim();
    if (chunk) out.push(chunk);
    start = i + 1;
  }
  const tail = line.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function cleanRoutedItem(raw: string): string {
  const text = normalizeItem(raw.replace(BULLET_RE, "").replace(/\*\*|__|`/g, ""));
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  const space = cut.lastIndexOf(" ");
  return (space > 100 ? cut.slice(0, space) : cut).replace(/[,:;.\s]+$/, "");
}

/**
 * Whether `line` continues a wrapped bullet whose text so far is `previous`:
 * the bullet had not ended its sentence, and the line picks up mid-sentence
 * (lowercase, or a code span or parenthesis). A capitalised line after an
 * unpunctuated bullet is a new paragraph, since list items often carry no
 * full stop.
 */
function continuesBullet(previous: string, line: string): boolean {
  return !/[.!?]$/.test(previous.trim()) && /^[a-z0-9(`]/.test(line);
}

/** Items from the lines of one out-of-scope section: a bullet's first sentence, or each prose sentence. */
function routedItemsFrom(lines: string[]): string[] {
  const blocks: { bullet: boolean; text: string }[] = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (BULLET_RE.test(line)) {
      blocks.push({ bullet: true, text: line.replace(BULLET_RE, "") });
    } else if (last && last.bullet && continuesBullet(last.text, line)) {
      last.text = `${last.text} ${line}`;
    } else if (last && !last.bullet) {
      // Wrapped prose: one paragraph, split into sentences below.
      last.text = `${last.text} ${line}`;
    } else {
      blocks.push({ bullet: false, text: line });
    }
  }
  const items: string[] = [];
  for (const block of blocks) {
    const clean = block.text.replace(/\*\*|__|`/g, "");
    const sentences = lineSentences(clean.replace(/\s+/g, " "));
    for (const sentence of block.bullet ? sentences.slice(0, 1) : sentences) {
      const item = cleanRoutedItem(sentence);
      if (item.length >= 5) items.push(item);
    }
  }
  return items;
}

// An explicit prohibition: a negated modal or verb, or a modal with never
// ("should never touch billing/").
const EXPLICIT_NEGATION_RE =
  /\b(do not|don't|must not|should not|shall not|will not|may not|cannot|can't|avoid)\b|\b(?:shall|must|should|will|may)\s+never\b/i;
// The narrower set kept inside a problem section, where "cannot" and "will
// not" usually describe today's behaviour rather than forbid anything. An
// imperative "Avoid X" is a prohibition wherever it appears.
const PROBLEM_KEEP_RE =
  /\b(do not|don't|must not|should not|shall not|may not|avoid)\b|\b(?:shall|must|should|may)\s+never\b|^never\b|^no\b.*\b(?:shall|must)\b/i;
const POSITIVE_MODAL_RE = /\b(?:shall|must|should|will)\s+(?!not\b|never\b|no\b)[a-z]+/i;

// A clause boundary inside one sentence: a semicolon, or a comma that opens a
// new negated clause ("MUST use the staging key, never the prod key").
const CLAUSE_SPLIT_RE =
  /;\s*|,\s*(?=(?:and\s+|but\s+|or\s+)?(?:never|no|not|do not|don't|must not|shall not|should not)\b)/i;

function sentenceClauses(sentence: string): string[] {
  return sentence
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

// What a "no" phrase governs decides whether it forbids anything. Only one
// shape is read as a modifier: "with no X" where X is a resource the run goes
// without ("SHALL run with no cloud credentials"). Every other "no" beside a
// positive modal stays a prohibition: "with no writes to billing/" (an action
// or a path), "SHALL show no wildcard Resource" (the modal's own object).
const NO_PHRASE_RE = /\b(\w+)\s+no\s+([^,.;:]{1,80})/gi;
const ACTION_NOUN_RE =
  /^(?:\S+\s+){0,2}?(?:writes?|changes?|edits?|modifications?|deletions?|deletes?|removals?|access|calls?|requests?|commits?|pushes?|updates?|uploads?|mutations?|installs?|migrations?|side\s+effects?)\b/i;
const PATH_LIKE_RE = /\/|\.[a-z]{2,5}\b/i;

/** True when some "no" in the clause is not a "with no <resource>" modifier. */
function hasProhibitiveNo(clause: string): boolean {
  for (const match of clause.matchAll(NO_PHRASE_RE)) {
    const before = match[1].toLowerCase();
    const phrase = match[2].trim();
    if (before !== "with") return true;
    if (ACTION_NOUN_RE.test(phrase) || PATH_LIKE_RE.test(phrase)) return true;
  }
  return false;
}

/**
 * A clause whose only prohibition marker is an embedded "no X" or "never X"
 * beside a positive modal IN THE SAME CLAUSE: "CI SHALL run, with no cloud
 * credentials: terraform validate, tflint". The "no" modifies the
 * requirement; it does not forbid anything. Still a prohibition: a clause that
 * starts with no or never, one with an explicit negation ("should never",
 * "SHALL NOT"), a coordinated "and never X", and any "no" other than "with no
 * <resource>" (see hasProhibitiveNo). When in doubt this keeps the
 * prohibition: a false one blocks loudly, a lost one passes silently.
 */
function isModifierOnlyNegation(clause: string): boolean {
  const trimmed = clause.replace(BULLET_RE, "").trim();
  if (!POSITIVE_MODAL_RE.test(trimmed)) return false;
  if (EXPLICIT_NEGATION_RE.test(trimmed)) return false;
  if (/^(no|never)\b/i.test(trimmed)) return false;
  if (/\b(?:and|or|but)\s+never\b/i.test(trimmed)) return false;
  if (hasProhibitiveNo(trimmed)) return false;
  return /\b(no|never)\s+/i.test(trimmed);
}

/**
 * Rebuild a line from the clauses `keep` accepts. A line with nothing dropped
 * goes through byte for byte, so text with no affected clause extracts exactly
 * as it did before.
 */
function filterClauses(line: string, keep: (clause: string) => boolean): string {
  const clauses = lineSentences(line.trim()).flatMap(sentenceClauses);
  const kept = clauses.filter(keep);
  if (kept.length === clauses.length) return line;
  if (kept.length === 0) return "";
  const bullet = line.trim().match(BULLET_RE)?.[0] ?? "";
  const joined = kept.join("; ");
  return bullet && !joined.startsWith(bullet.trim()) ? `${bullet}${joined}` : joined;
}

function withoutModifierNegations(line: string): string {
  return filterClauses(line, (clause) => !isModifierOnlyNegation(clause));
}

/** In a problem section, only explicit prohibitions survive. */
function problemProhibitions(line: string): string {
  return filterClauses(line, (clause) => PROBLEM_KEEP_RE.test(clause.replace(BULLET_RE, "").trim()));
}

export interface SegmentedText {
  /** Text in_scope and acceptance criteria are read from: no out-of-scope sections, no tables. */
  scopeText: string;
  /** Text prohibitions are read from: ordinary sections only, modifier-only negations dropped. */
  prohibitionText: string;
  /** out_of_scope items routed by heading, by label, or by an "is out of scope" sentence, in document order. */
  routed: string[];
}

export function segmentForExtraction(text: string): SegmentedText {
  const scope: string[] = [];
  const prohibition: string[] = [];
  const routedHeading: string[] = [];
  const routedDeclared: string[] = [];
  // A real `#` heading's section runs to the next heading of the same or a
  // higher level, and a child heading with no kind of its own is neutral: it
  // never inherits problem or out_of_scope from its parent, so a requirement
  // nested under a Non-goals heading is still a requirement.
  //
  // listOnly: a classified pseudo-heading (a bold line, or a plain "Label:"
  // line). It holds bullets and their wrapped lines only, and the first other
  // line closes it, so it never swallows the prose that follows. An
  // unclassified pseudo-heading ("**Acceptance criteria**") changes nothing.
  const stack: { level: number; kind: SectionKind; listOnly: boolean }[] = [];
  let pending: string[] = [];
  // The last line of the bullet being routed, while a wrapped line could
  // still continue it.
  let bulletTail: string | null = null;

  const kindNow = (): SectionKind => stack[stack.length - 1]?.kind ?? "normal";
  const flush = (): void => {
    if (pending.length > 0) routedHeading.push(...routedItemsFrom(pending));
    pending = [];
    bulletTail = null;
  };
  const open = (level: number, title: string, pseudo: boolean): void => {
    flush();
    const own = classifyHeading(title);
    if (pseudo && own === null) return;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, kind: own ?? "normal", listOnly: pseudo });
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (TABLE_ROW_RE.test(line)) continue;

    const top = stack[stack.length - 1];
    const continuation: boolean = bulletTail !== null && continuesBullet(bulletTail, line);
    if (top?.listOnly && line.length > 0 && !BULLET_RE.test(line) && !continuation) {
      // The list is over: close it and read this line in the enclosing section.
      flush();
      stack.pop();
    }

    const atx = line.match(ATX_HEADING_RE);
    const bold = atx ? null : line.match(BOLD_HEADING_RE);
    const colon =
      atx || bold ? null : line.match(COLON_LABEL_RE);
    const colonOpensList = colon !== null && classifyHeading(colon[1]) === "out_of_scope";
    if (atx || bold || colonOpensList) {
      const title = atx ? atx[2] : bold ? bold[2] : colon![1];
      open(atx ? atx[1].length : PSEUDO_HEADING_LEVEL, title, !atx);
      // The heading's own words stay in the text, as before, unless it opens
      // an out-of-scope section (or, for prohibitions, a problem section).
      const kind = kindNow();
      if (kind !== "out_of_scope") scope.push(atx ? title : line);
      if (kind === "normal") prohibition.push(atx ? title : line);
      bulletTail = null;
      continue;
    }

    const label = line.match(BOLD_LABEL_RE);
    if (label && classifyHeading(label[2]) === "out_of_scope") {
      flush();
      routedHeading.push(...routedItemsFrom([label[3]]));
      continue;
    }

    const kind = kindNow();
    // Tracked in every section, since a problem list closes the same way an
    // out-of-scope list does.
    bulletTail = line.length > 0 && (BULLET_RE.test(line) || continuation) ? line : null;
    if (kind === "out_of_scope") {
      if (line.length > 0) pending.push(line);
      continue;
    }

    scope.push(raw);
    if (kind === "problem") {
      // A bare "no X" or "never X" here describes today; an explicit
      // prohibition ("MUST NOT touch billing/", a leading "Never edit") is
      // still a rule.
      prohibition.push(problemProhibitions(raw));
      continue;
    }
    // A Kiro user story ("As a contributor, I do not want to open a
    // 1,791-line module") is motivation, not a rule.
    if (USER_STORY_RE.test(line)) continue;
    for (const sentence of lineSentences(line)) {
      const declared = sentence.match(DECLARED_OUT_OF_SCOPE_RE);
      if (declared) {
        const item = cleanRoutedItem(declared[1]);
        if (item.length >= 5) routedDeclared.push(item);
      }
    }
    prohibition.push(withoutModifierNegations(raw));
  }
  flush();

  return {
    scopeText: scope.join("\n"),
    prohibitionText: prohibition.join("\n"),
    routed: [...routedHeading, ...routedDeclared],
  };
}

function extractAcceptanceCriteria(
  text: string,
  inScope: string[],
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const clauses = textClauses(text);

  for (const clause of clauses) {
    if (
      /\b(verify|test|should|must|when|done when|acceptance)\b/i.test(clause) &&
      clause.length >= 10
    ) {
      const description = normalizeItem(
        clause.replace(/^done when\s+/i, "").replace(/^acceptance:\s*/i, ""),
      );
      if (description.length <= 200) {
        criteria.push({
          id: `ac-${criteria.length + 1}`,
          description,
          testable: true,
        });
      }
    }
  }

  if (criteria.length > 0) return criteria.slice(0, 15);

  const defaults = inScope.slice(0, 4).map((item, i) => ({
    id: `ac-${i + 1}`,
    description: ACTION_START_RE.test(item)
      ? `Verify ${item}`
      : `Verify: ${item}`,
    testable: true,
  }));

  if (defaults.length === 0) {
    defaults.push({
      id: "ac-1",
      description: "User can complete the described workflow without errors",
      testable: true,
    });
  }

  return defaults;
}

/** The most out_of_scope items a draft carries: the contract schema's maxItems. */
export const OUT_OF_SCOPE_CAP = 12;

// An item that states its prohibition explicitly, ranked first.
const EXPLICIT_ITEM_RE =
  /^(?:shall not|must not|should not|may not|do not|don't)\b|^no\b.*\b(?:shall|must)\b/i;

export interface DraftDetails {
  contract: IntentContract;
  /** out_of_scope items merged into a longer near-duplicate, for --verbose. */
  replaced: RuleReplacement[];
}

export function draftContract(input: DraftContractInput): IntentContract {
  return draftContractDetailed(input).contract;
}

export function draftContractDetailed(input: DraftContractInput): DraftDetails {
  const { userText, constraints = [] } = input;
  const ruleTexts = constraintRuleTexts(constraints);
  const segmented = segmentForExtraction(userText);
  const inScope = extractInScope(segmented.scopeText);
  const promptQuality = scorePrompt(userText, {
    constraints: ruleTexts,
    hasAcceptanceCriteria: /\b(verify|test|should|must|done)\b/i.test(userText),
  });

  const extracted = extractOutOfScope(segmented.prohibitionText);
  const embedded = extractEmbeddedProhibitions(segmented.prohibitionText).filter(
    (item) => !extracted.replaced.has(item.toLowerCase()),
  );
  // Ranked, then capped: the spec's routed non-goals first, then explicit
  // prohibitions (SHALL NOT, MUST NOT, Do not, "No X SHALL ..."), then every
  // other prohibition. Measured on three public repositories, putting the
  // explicit tier first let keyword-matched fragments of long Kiro specs
  // crowd out the non-goals and wrongly blocked 5 of 20 real commits; routed
  // first blocked 2 of 20. The cap is the schema's own maxItems, so a draft
  // always validates.
  const prohibitions = [...extracted.items, ...embedded];
  const explicit = prohibitions.filter((item) => EXPLICIT_ITEM_RE.test(item));
  const rest = prohibitions.filter((item) => !EXPLICIT_ITEM_RE.test(item));
  // Near-duplicates (same words once case, punctuation and the leading
  // negation are folded, or one a word-bounded part of the other) merge into
  // the longer, in the earlier item's ranked place.
  const deduped = dedupeRules(
    uniqueItems([...segmented.routed, ...explicit, ...rest], Number.MAX_SAFE_INTEGER),
  );
  const outOfScope = deduped.kept
    .filter((item, index, unique) => {
      const key = item.toLowerCase();
      return !unique.slice(0, index).some((previous) => previous.toLowerCase().includes(key));
    })
    .slice(0, OUT_OF_SCOPE_CAP);

  const contract: IntentContract = {
    contract_id: generateContractId(),
    version: "1.0.0",
    original_ask: wholeAsk(input.ask ?? userText),
    in_scope: inScope,
    out_of_scope: outOfScope,
    constraints,
    acceptance_criteria: extractAcceptanceCriteria(segmented.scopeText, inScope),
    frozen_at: new Date().toISOString(),
    prompt_quality: {
      score: promptQuality.score,
      issues: promptQuality.issues,
      coaching_shown: promptQuality.score < 60,
    },
    pivot_log: [],
  };
  return { contract, replaced: deduped.replaced };
}
