import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Constraint, ConstraintSource } from "@vaultcompass/intent-guard-schema";
import { prohibitedSubject, stripEmphasis, tokenize } from "./tokenize.js";

export const DEFAULT_CONSTRAINT_FILES: ConstraintSource[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

export interface LoadedConstraints {
  constraints: Constraint[];
  loadedFiles: string[];
  /** Near-duplicate rules merged away by loadAllConstraints, for --verbose. */
  replaced?: RuleReplacement[];
}

const PRIORITY_RANK: Record<Constraint["priority"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function normalizeConstraintRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One near-duplicate merge: the rule that stayed and the one it replaced. */
export interface RuleReplacement {
  kept: string;
  replaced: string;
}

export interface DedupeOptions {
  /**
   * Only merge rules of the same polarity (a prohibition with a
   * prohibition, anything else with anything else). Off for out_of_scope,
   * where every item forbids whatever its words name, "No PDF export" and
   * "PDF export" alike; on for constraints, where "Use the logger" and
   * "Never use the logger" share every word and mean opposite things.
   */
  polarity?: boolean;
}

const NEGATED_RULE_RE =
  /\b(?:must not|mustn't|never|do not|don't|shall not|should not|shouldn't|cannot|can't|will not|won't|may not|avoid)\b/i;

function rulePolarity(rule: string): "prohibit" | "other" {
  if (prohibitedSubject(rule) !== stripEmphasis(rule.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")).trim()) {
    return "prohibit";
  }
  return NEGATED_RULE_RE.test(rule) ? "prohibit" : "other";
}

/** A rule's dedupe key: lowercased, punctuation and whitespace folded, leading negation removed. */
export function ruleDedupeKey(rule: string): string {
  return normalizeConstraintRule(prohibitedSubject(rule));
}

/** Whether key `small` is the same as, or a word-bounded part of, key `large`. */
function sameOrContained(small: string, large: string): boolean {
  return small === large || ` ${large} `.includes(` ${small} `);
}

/**
 * Whether two rules carry the same drift tokens. A superset only absorbs a
 * rule when its extra words are ones drift ignores ("Do not add any PDF
 * export" over "PDF export"). A superset with words of its own is narrower
 * as a matcher: folding "Do not touch billing" into "Do not touch billing
 * (Stripe or Braintree) code" drops a billing path's coverage from 0.5
 * (strong) to 0.25 (none), so both are kept.
 */
function sameMatchTokens(a: string, b: string): boolean {
  const left = tokenize(a);
  const right = tokenize(b);
  return left.size === right.size && [...left].every((token) => right.has(token));
}

/**
 * Merge near-identical items, generic over what carries the rule text. Two
 * items merge when their keys are equal, or when one key is a prefix or a
 * word-bounded part of the other and both carry the same drift tokens (and,
 * with `polarity`, both have the same polarity). The longer text is kept, in
 * the place of whichever came first, so a ranked list keeps its order;
 * `merge` decides what the kept item is when two collide.
 */
export function dedupeBy<T>(
  items: T[],
  textOf: (item: T) => string,
  options: DedupeOptions & { merge?: (winner: T, loser: T) => T } = {},
): { kept: T[]; replaced: RuleReplacement[] } {
  const kept: { item: T; key: string; polarity: string }[] = [];
  const replaced: RuleReplacement[] = [];
  const merge = options.merge ?? ((winner: T) => winner);

  for (const item of items) {
    const text = textOf(item);
    const key = ruleDedupeKey(text);
    if (!key) continue;
    const polarity = options.polarity ? rulePolarity(text) : "any";
    const index = kept.findIndex(
      (entry) =>
        entry.polarity === polarity &&
        (entry.key === key ||
          ((sameOrContained(entry.key, key) || sameOrContained(key, entry.key)) &&
            sameMatchTokens(entry.key, key))),
    );
    if (index === -1) {
      kept.push({ item, key, polarity });
      continue;
    }
    const existing = kept[index];
    const existingText = textOf(existing.item);
    const nextWins = text.trim().length > existingText.trim().length;
    const winner = nextWins ? item : existing.item;
    const loser = nextWins ? existing.item : item;
    kept[index] = { item: merge(winner, loser), key: nextWins ? key : existing.key, polarity };
    replaced.push({ kept: textOf(winner), replaced: textOf(loser) });
  }

  return { kept: kept.map((entry) => entry.item), replaced };
}

/** dedupeBy over plain rule strings. */
export function dedupeRules(
  rules: string[],
  options: DedupeOptions = {},
): { kept: string[]; replaced: RuleReplacement[] } {
  return dedupeBy(rules, (rule) => rule, options);
}

/**
 * Constraints merged by polarity-aware near-duplicate key. The kept
 * constraint is the longer rule, carrying the higher of the two priorities,
 * so a merge never lowers how seriously a rule is taken. Between two
 * identical texts the higher-priority one (and its source) is kept.
 */
export function dedupeConstraintsDetailed(constraints: Constraint[]): {
  kept: Constraint[];
  replaced: RuleReplacement[];
} {
  return dedupeBy(constraints, (c) => c.rule, {
    polarity: true,
    merge: (winner, loser) => {
      const sameText = winner.rule.trim().length === loser.rule.trim().length;
      const base = sameText && PRIORITY_RANK[loser.priority] > PRIORITY_RANK[winner.priority] ? loser : winner;
      const priority =
        PRIORITY_RANK[loser.priority] > PRIORITY_RANK[winner.priority] ? loser.priority : winner.priority;
      return { ...base, priority };
    },
  });
}

export function dedupeConstraints(constraints: Constraint[]): Constraint[] {
  return dedupeConstraintsDetailed(constraints).kept;
}

function inferPriority(line: string): Constraint["priority"] {
  if (/\b(MUST NOT|NEVER|CRITICAL|DO NOT)\b/i.test(line)) return "critical";
  if (/\b(MUST|IMPORTANT|REQUIRED)\b/i.test(line)) return "high";
  if (/\b(should|prefer|avoid)\b/i.test(line)) return "medium";
  return "low";
}

function cleanRule(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

// Normative language that marks a line as an actual rule, not prose/metadata.
const NORMATIVE =
  /\b(must not|must|never|do not|don't|dont|shall not|shall|always|required|avoid|prefer|cannot|can't|should not|should|minimi[sz]e)\b/i;
// A leading prohibition like "No new API endpoints".
const LEADING_PROHIBITION = /^no\s+\w+/i;
// Headings under which bullet items are rules even without a keyword.
const RULE_HEADING =
  /\b(constraint|rule|boundar|guardrail|do not|must|principle|requirement|polic|invariant)/i;

const BULLET = /^([-*]\s+|\d+\.\s+)/;

// A bullet that's just a code-span reference (e.g. a file path) has no
// natural-language content and isn't a rule statement on its own, even
// under a rules-style heading.
function isBareCodeSpanReference(rule: string): boolean {
  const withoutCodeSpans = rule.replace(/`[^`]*`/g, "").trim();
  return withoutCodeSpans.length === 0;
}

function isRuleLine(
  rule: string,
  wasBullet: boolean,
  underRuleHeading: boolean,
): boolean {
  if (NORMATIVE.test(rule)) return true;
  if (LEADING_PROHIBITION.test(rule)) return true;
  if (underRuleHeading && wasBullet && !isBareCodeSpanReference(rule)) return true;
  return false;
}

/** The longest rule the contract schema accepts. */
const MAX_RULE_LENGTH = 300;

/**
 * One paragraph or one list item, with its hard-wrapped lines joined by a
 * space. `kind` says how the unit started, so tables and blockquotes can be
 * skipped as a whole rather than line by line.
 */
export interface MarkdownUnit {
  text: string;
  kind: "paragraph" | "bullet" | "table" | "quote";
  underRuleHeading: boolean;
}

/**
 * Split markdown into paragraphs and list items. A blank line, a heading, a
 * fence, a thematic break, a list marker, or a switch into or out of a table
 * or blockquote ends the unit; any other line continues it, because a hard
 * line break inside a paragraph is only a space. YAML front matter at the top
 * of the file is dropped.
 */
export function markdownUnits(content: string): MarkdownUnit[] {
  const units: MarkdownUnit[] = [];
  const lines = content.split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close > 0) start = close + 1;
  }

  let inFence = false;
  let underRuleHeading = false;
  let current: MarkdownUnit | null = null;
  const flush = (): void => {
    if (current) units.push({ ...current, text: current.text.replace(/\s+/g, " ").trim() });
    current = null;
  };

  for (const raw of lines.slice(start)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0 || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      continue;
    }
    if (line.startsWith("#")) {
      flush();
      underRuleHeading = RULE_HEADING.test(line);
      continue;
    }
    const marked: MarkdownUnit["kind"] | null = line.startsWith("|")
      ? "table"
      : line.startsWith(">")
        ? "quote"
        : BULLET.test(line)
          ? "bullet"
          : null;
    // Read through a typed local: TypeScript cannot see flush() reset it.
    const open = current as MarkdownUnit | null;
    const startsUnit =
      marked === "bullet" ||
      (marked !== null && open?.kind !== marked) ||
      (marked === null && (open?.kind === "table" || open?.kind === "quote"));
    if (startsUnit || !open) {
      flush();
      current = { text: line, kind: marked ?? "paragraph", underRuleHeading };
      continue;
    }
    open.text = `${open.text} ${line}`;
  }
  flush();
  return units;
}

/** Whole sentences of a unit: a terminator, whitespace, then a new sentence's first character. */
function unitSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9*_`"'(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  // An abbreviation's full stop ends no sentence: rejoin "e.g." and friends.
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && ABBREVIATION_END_RE.test(last)) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

const ABBREVIATION_END_RE = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp)\.$/i;

/**
 * Extract genuine rules from a markdown constraint file.
 *
 * The unit is a paragraph or a list item, never a physical line. Through
 * 1.9.0 each line was judged alone, so a hard-wrapped paragraph yielded
 * sentence fragments, and a continuation line that happened to hold "never"
 * became a critical rule by itself. A rule is now always a whole unit or,
 * for a unit longer than the schema's 300-character rule limit, a whole
 * sentence of one.
 *
 * Precision over recall: a unit qualifies only if it uses normative language
 * (MUST/NEVER/should/avoid/prefer…), is a leading prohibition ("No new …"), or
 * is a bullet under a rules-style heading. This filters out doc prose, metadata
 * (tags, links, goals) and tables that the previous "any bullet line" heuristic
 * scraped as bogus constraints, which a live run against a real project found
 * as its first and worst source of noise.
 */
export function extractConstraintsFromMarkdown(
  content: string,
  source: ConstraintSource,
  filePath?: string,
): Constraint[] {
  const constraints: Constraint[] = [];

  const units = markdownUnits(content);
  for (const [index, unit] of units.entries()) {
    if (unit.kind === "table" || unit.kind === "quote") continue;
    // A line ending in a colon that introduces a list ("You must follow
    // these rules:") is a heading for the items, not a rule of its own.
    if (unit.text.trimEnd().endsWith(":") && units[index + 1]?.kind === "bullet") continue;
    if (/\bhttps?:\/\//i.test(unit.text)) continue; // link/url-bearing prose

    const wasBullet = unit.kind === "bullet";
    const whole = cleanRule(unit.text);
    // A unit too long for the schema's rule limit is judged one whole
    // sentence at a time, so a rule is a whole unit or a whole sentence.
    const candidates = whole.length <= MAX_RULE_LENGTH ? [whole] : unitSentences(whole);
    for (const rule of candidates) {
      if (rule.length < 10 || rule.length > MAX_RULE_LENGTH) continue;
      if (!isRuleLine(rule, wasBullet && candidates.length === 1, unit.underRuleHeading)) continue;
      constraints.push({
        source,
        rule,
        priority: inferPriority(rule),
        file_path: filePath,
      });
    }
  }

  return constraints.slice(0, 15);
}

export function loadCursorRules(projectRoot: string): LoadedConstraints {
  const rulesDir = join(projectRoot, ".cursor", "rules");
  const constraints: Constraint[] = [];
  const loadedFiles: string[] = [];

  if (!existsSync(rulesDir)) {
    return { constraints, loadedFiles };
  }

  for (const name of readdirSync(rulesDir)) {
    if (!name.endsWith(".mdc") && !name.endsWith(".md")) continue;
    const rel = join(".cursor/rules", name);
    const content = readFileSync(join(rulesDir, name), "utf8");
    loadedFiles.push(rel);
    constraints.push(
      ...extractConstraintsFromMarkdown(content, "cursor-rules", rel),
    );
  }

  return { constraints, loadedFiles };
}

export function loadAllConstraints(projectRoot: string): LoadedConstraints {
  const fromFiles = loadConstraintFiles(projectRoot);
  const fromRules = loadCursorRules(projectRoot);
  const deduped = dedupeConstraintsDetailed([...fromFiles.constraints, ...fromRules.constraints]);
  return {
    constraints: deduped.kept,
    loadedFiles: [...fromFiles.loadedFiles, ...fromRules.loadedFiles],
    replaced: deduped.replaced,
  };
}

export function loadConstraintFiles(projectRoot: string): LoadedConstraints {
  const constraints: Constraint[] = [];
  const loadedFiles: string[] = [];

  for (const filename of DEFAULT_CONSTRAINT_FILES) {
    const path = join(projectRoot, filename);
    if (!existsSync(path)) continue;
    loadedFiles.push(filename);
    const content = readFileSync(path, "utf8");
    constraints.push(...extractConstraintsFromMarkdown(content, filename, filename));
  }

  return { constraints, loadedFiles };
}

export function constraintRuleTexts(constraints: Constraint[]): string[] {
  return constraints.map((c) => c.rule);
}
