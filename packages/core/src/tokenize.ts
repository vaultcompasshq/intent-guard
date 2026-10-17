// Generic, domain-agnostic tokenization shared by the drift scorer.
//
// The goal is NOT perfect NLP. It is a defensible, project-independent way to
// decide whether a changed path or a free-text signal "touches" an out-of-scope
// item or a constraint, without hardcoding any particular project's vocabulary.

// Words that carry no scope meaning. Kept small and generic.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "without", "no", "not", "new", "must", "should", "shall", "never", "do",
  "does", "did", "done", "only", "all", "any", "into", "from", "this", "that",
  "these", "those", "is", "are", "be", "been", "being", "explicit", "your",
  "our", "their", "its", "it", "as", "at", "by", "via", "use", "using",
  "add", "added", "adding", "change", "changes", "changed", "etc",
]);

// Generic file/path and code tokens that appear everywhere and therefore
// discriminate nothing. Matching on these produces noise, not signal.
const GENERIC_TOKENS = new Set([
  "index", "src", "lib", "dist", "build", "node", "modules", "test", "tests",
  "spec", "specs", "util", "utils", "types", "main", "app", "pkg", "package",
  "packages", "json", "yaml", "yml", "md", "ts", "tsx", "js", "jsx", "mjs",
  "cjs", "html", "css", "scss", "file", "files", "code", "config",
]);

// Tokens that appear in paths and meta-rules but rarely indicate drift alone.
export const CONSTRAINT_NOISE_TOKENS = new Set([
  "task", "tasks", "hooks", "hook", "component", "components", "web",
  "refactor", "beyond", "variant", "variants", "button", "buttons",
  "acceptable", "semantic", "design", "system", "tokens", "token", "raw",
  "what", "requires", "other", "only", "map", "controls", "nav", "links", "tab",
  "inline", "style", "styles", "always", "prefer",
]);

// When a prohibition mentions these, a path hit on a vendor name alone is weak.
export const OUT_OF_SCOPE_QUALIFIER_TOKENS = new Set([
  "production", "credential", "credentials", "secret", "secrets", "dashboard",
  "migration", "migrations", "deploy", "deployment", "billing", "stripe",
  "environment", "console", "operator", "vendor", "metadata", "manifest",
]);

const MIN_TOKEN_LENGTH = 3;

// Leading negation markers of a rule. "don't" tokenizes to "don", "won't" to
// "won", and "cannot" and "avoid" are ordinary tokens, so left in place they
// became terms to match and diluted coverage. Stacked markers ("Never, do
// not ...") are all removed.
const LEADING_NEGATION_RE =
  /^(?:no|do\s+not|don['’]?t|never|must\s+not|mustn['’]?t|should\s+not|shouldn['’]?t|shall\s+not|cannot|can['’]?t|will\s+not|won['’]?t|may\s+not|avoid)\b[\s,:;]*/i;

// A paired emphasis marker around words: it opens and closes off a word
// boundary, so the underscore inside payment_methods or id_rsa is never one.
const EMPHASIS_RE = /(?<![A-Za-z0-9])(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1(?![A-Za-z0-9])/g;

/**
 * Markdown emphasis and code spans removed, identifiers left whole: "**Never**
 * touch `payment_methods`" becomes "Never touch payment_methods".
 */
export function stripEmphasis(text: string): string {
  let out = text.replace(/`/g, "");
  for (;;) {
    const next = out.replace(EMPHASIS_RE, "$2");
    if (next === out) return out;
    out = next;
  }
}

/**
 * The thing a rule prohibits: the rule with its list marker, emphasis and
 * leading negation markers removed ("Don't modify billing" -> "modify
 * billing"). Matchers are built from this; the rule text itself is kept as
 * written everywhere else. A rule with no leading marker comes back trimmed.
 */
export function prohibitedSubject(rule: string): string {
  let text = stripEmphasis(rule.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")).trim();
  for (;;) {
    const next = text.replace(LEADING_NEGATION_RE, "").trim();
    if (next === text || next.length === 0) return text;
    text = next;
  }
}

/**
 * Break text into normalized, meaningful tokens.
 *
 * - splits camelCase (`useWebSocket` -> use web socket)
 * - splits on any non-alphanumeric boundary (paths, snake_case, punctuation)
 * - lowercases, drops stopwords, generic file/code tokens, and short tokens
 */
export function tokenize(text: string): Set<string> {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const raw = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const tokens = new Set<string>();
  for (const word of raw) {
    if (word.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(word)) continue;
    if (GENERIC_TOKENS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

/**
 * Two tokens match if they are equal, or one contains the other and the
 * shorter token is at least 4 characters (handles plurals/stems like
 * stub/stubbed, score/scores -- while avoiding noise from 3-char fragments).
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return false;
}

/** Tokens of `set` that have a match in `other`. */
export function intersectingTokens(set: Set<string>, other: Set<string>): string[] {
  const hits: string[] = [];
  for (const a of set) {
    for (const b of other) {
      if (tokensMatch(a, b)) {
        hits.push(a);
        break;
      }
    }
  }
  return hits;
}

/**
 * Discriminating tokens of `text`: its tokens minus any token that also
 * describes the agreed in-scope work. A token shared with in-scope is not
 * evidence of drift -- e.g. "PDF export" vs in-scope "CSV export" both reduce
 * to "export", so "export" is removed and only "pdf" remains discriminating.
 */
export function discriminatingTokens(
  text: string,
  scopeTokens: Set<string>,
): Set<string> {
  const tokens = tokenize(text);
  const result = new Set<string>();
  for (const t of tokens) {
    let shared = false;
    for (const s of scopeTokens) {
      if (tokensMatch(t, s)) {
        shared = true;
        break;
      }
    }
    if (!shared) result.add(t);
  }
  return result;
}

/** Path segments from `/`, `.`, `-`, `_` -- used to avoid substring false positives. */
export function pathSegmentTokens(path: string): Set<string> {
  const segments = new Set<string>();
  const normalized = path.toLowerCase().replace(/\\/g, "/");
  for (const part of normalized.split("/")) {
    if (!part) continue;
    for (const piece of part.split(/[._-]+/)) {
      if (piece.length < MIN_TOKEN_LENGTH) continue;
      if (STOPWORDS.has(piece)) continue;
      if (GENERIC_TOKENS.has(piece)) continue;
      segments.add(piece);
    }
  }
  return segments;
}

/**
 * Tokens the path-category classifier in drift.ts pushes onto a changed path.
 * They count as ordinary evidence: they only exist when a matching path
 * shape actually changed.
 */
export const CATEGORY_TOKENS = new Set([
  "source",
  "readme",
  "documentation",
  "metadata",
  "dependency",
  "manifest",
  "api",
  "endpoint",
  "test",
]);

export type MatchStrength = "strong" | "partial" | "none";

export interface MatchThresholds {
  strong_coverage?: number;
  partial_coverage?: number;
}

/**
 * Coverage gate. Replaces any-shared-token matching. `matched` is already
 * the overlap; this decides whether that overlap is enough to count.
 * Stopwords are never evidence. For constraints, pass
 * CONSTRAINT_NOISE_TOKENS as extra never-evidence (the 1.0.5 false-positive
 * guard). Category tokens count as ordinary evidence. Strong is coverage
 * at or above strong_coverage with at least one non-noise evidence token.
 * Partial is coverage at or above partial_coverage.
 */
export function matchStrength(
  discriminating: Set<string>,
  matched: string[],
  thresholds: MatchThresholds = {},
  extraNeverEvidence?: ReadonlySet<string>,
): MatchStrength {
  const strongCoverage = thresholds.strong_coverage ?? 0.5;
  const partialCoverage = thresholds.partial_coverage ?? 0.3;
  const evidence = matched.filter(
    (token) => !STOPWORDS.has(token) && !extraNeverEvidence?.has(token),
  );
  if (evidence.length === 0) return "none";
  if (discriminating.size === 0) return "none";
  const coverage = evidence.length / discriminating.size;
  if (coverage >= strongCoverage) return "strong";
  if (coverage >= partialCoverage) return "partial";
  return "none";
}

const SLASH_FRAGMENT_RE = /[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)+/g;

/** Slash-joined path fragments in `text`, as lowercase whole segments. */
export function slashJoinedFragments(text: string): string[][] {
  const fragments: string[][] = [];
  for (const match of text.matchAll(SLASH_FRAGMENT_RE)) {
    const segments = match[0]
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    if (segments.length === 0) continue;
    fragments.push(segments);
  }
  return fragments;
}

/** True when `path` contains `segments` as consecutive whole path parts. */
export function pathHasConsecutiveSegments(
  path: string,
  segments: string[],
): boolean {
  if (segments.length === 0) return false;
  const parts = path
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length < segments.length) return false;
  for (let i = 0; i <= parts.length - segments.length; i++) {
    if (segments.every((segment, offset) => parts[i + offset] === segment)) {
      return true;
    }
  }
  return false;
}

/**
 * Slash-joined fragments in `text` that appear as consecutive whole
 * segments on a changed path. Order matters; no substring matches.
 */
export function slashJoinedPathHits(
  text: string,
  changedPaths: string[],
): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const segments of slashJoinedFragments(text)) {
    if (!changedPaths.some((path) => pathHasConsecutiveSegments(path, segments))) {
      continue;
    }
    const key = segments.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(key);
  }
  return hits;
}

/** The words of a rule as written, with quotes, backticks, brackets and trailing punctuation trimmed. */
function ruleWords(rule: string): string[] {
  return rule
    .split(/\s+/)
    .map((word) =>
      word
        .replace(/^[`'"(\[<]+/, "")
        .replace(/[`'")\]>,;:!?]+$/, "")
        .replace(/\.$/, ""),
    )
    .filter(Boolean);
}

/**
 * The closed file-name rule. A word of the rule, plain or backticked, names a
 * changed file when it is exactly that file's basename (".env.local",
 * "CODEOWNERS", "Dockerfile", "id_rsa"), or exactly the basename without its
 * final extension ("CHANGELOG" for CHANGELOG.md, ".env" for .env.local,
 * "secrets" for secrets.json), or a "*.ext" word whose extension ends the
 * basename ("*.pem" for server.pem). Case-sensitive. Such a match is a path
 * match, so the file-name tokens it rests on count. Nothing else about a file
 * name is: a bare word found inside a name ("sync" in SyncStatus.tsx) is not.
 */
export function namesChangedFile(rule: string, changedPaths: string[]): boolean {
  const words = ruleWords(rule);
  if (words.length === 0) return false;
  for (const path of changedPaths) {
    const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
    if (!base) continue;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : null;
    for (const word of words) {
      if (word === base || (stem !== null && word === stem)) return true;
      if (/^\*\.[^./*]+$/.test(word) && base.length > word.length - 1 && base.endsWith(word.slice(1))) return true;
    }
  }
  return false;
}

/**
 * Out-of-scope path matching: when a prohibition names sensitive qualifiers
 * (production, credentials, …), a lone vendor token in a filename is not enough.
 */
export function outOfScopeTouch(
  discriminating: Set<string>,
  target: Set<string>,
  pathSegs: Set<string>,
): string[] {
  const matched = intersectingTokens(discriminating, target);
  if (matched.length === 0) return [];

  const qualifiers = [...discriminating].filter((t) =>
    [...OUT_OF_SCOPE_QUALIFIER_TOKENS].some((q) => tokensMatch(t, q)),
  );
  if (qualifiers.length === 0) return matched;

  const qualHits = intersectingTokens(new Set(qualifiers), target);
  if (qualHits.length > 0) return matched;

  const pathHits = intersectingTokens(discriminating, pathSegs);
  if (pathHits.length > 0) return [];

  return matched;
}

/** Meta-rules that tend to false-block any touch of common path tokens. */
export function isDriftNoisyConstraintRule(rule: string): boolean {
  return (
    /\b(refactor|restructure|clean up).*\b(beyond|outside|what).*\b(task|scope)\b/i.test(
      rule,
    ) ||
    /\bskip hooks?\b/i.test(rule) ||
    /\b(raw hex|css tokens?|design-system\.css)\b/i.test(rule) ||
    /\buse the .*<Button>\b/i.test(rule) ||
    /\braw <button>\b/i.test(rule)
  );
}
