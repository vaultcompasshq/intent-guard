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
  let out = text;
  for (;;) {
    const next = stripEmphasisOnce(out);
    if (next === out) return out;
    out = next;
  }
}

/** One step of stripEmphasis: code spans and one layer of paired emphasis. */
function stripEmphasisOnce(text: string): string {
  return text.replace(/`/g, "").replace(EMPHASIS_RE, "$2");
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
  // A Windows path is a path: "src\Dockerfile" is src/Dockerfile.
  for (const match of text.replace(/\\/g, "/").matchAll(SLASH_FRAGMENT_RE)) {
    // A segment never ends in sentence punctuation: "src/Dockerfile." at the
    // end of a sentence is the path src/Dockerfile.
    const segments = match[0]
      .split("/")
      .map((segment) => segment.replace(/[.,;:!?]+$/, "").toLowerCase())
      .filter(Boolean);
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

// Relative "./" and "../" prefixes, or a lone leading "/", before a name:
// "./Dockerfile", "../../CHANGELOG.md".
const LEADING_PATH_RE = /^(?:\.{1,2}\/)+|^\/(?!\/)/;
// A footnote, note or reference-link marker after a name: "Dockerfile[^1]",
// "Dockerfile[1].", "[CHANGELOG.md][1]". Never a whole bracketed word.
const TRAILING_MARKER_RE = /(?<=[^\s[])\[[^\][]*\][.,;:!?]*$/;
// A markdown link inside one word: "[CHANGELOG.md](./CHANGELOG.md)", or the
// last word of "[the Dockerfile](./Dockerfile)".
const LINK_RE = /^(.*)\]\(([^()\s]*)\)(.*)$/;
// A "*.ext" glob with emphasis stars around it: "*.pem*", "**.pem**".
const STARRED_GLOB_RE = /^\*+(\.[^./*]+)\*+$/;
// Any Unicode punctuation, symbol or format character: quotes of every
// script, sentence marks of every script, "$", "@", "#", backticks, angle
// brackets, zero-width spaces and soft hyphens. A class, never a list, so a
// wrapper nobody listed is still trimmed.
const EDGE_CHAR_RE = /[\p{P}\p{S}\p{Cf}]/u;
// What the edge trim leaves in place. "_" is part of an identifier
// (old_payment_, __init__) and only paired emphasis removes it; "/" and "\"
// belong to paths; a leading "." starts a dotfile (.env); and a leading "~"
// is a home directory, which names nothing here by ruling (~/Dockerfile).
const KEEP_LEADING = new Set(["_", "/", "\\", ".", "~"]);
const KEEP_TRAILING = new Set(["_", "/", "\\"]);
// A markdown backslash escape: a backslash before ASCII punctuation
// ("payment\_methods", "\*.pem"). A backslash before anything else is left
// for the Windows-path reading.
const MARKDOWN_ESCAPE_RE = /\\([!-/:-@[-`{-~])/g;
// An HTML tag ("<code>", "</kbd>", "<br/>"). It must open with a letter, so
// "<./Dockerfile>" (a link target) is not one.
const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;
// An HTML element with its closing tag ("<code>...</code>"). Removing only
// paired tags keeps a lone "<Dockerfile>" inside one for the angle-bracket
// reading.
const HTML_ELEMENT_RE = /<([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?>(.*?)<\/\1\s*>/g;
// A cap on the forms one word is reduced through; real words reach a few
// dozen at most.
const MAX_WORD_FORMS = 512;

/**
 * `word` with characters in EDGE_CHAR_RE trimmed from both ends, except
 * those the KEEP sets name. Emphasis stars are trimmed too; the form before
 * the trim is kept, and stripEmphasisOnce reads its pairs anywhere in the
 * word, so a trim never loses a pair ("**payment**_methods"). The one star
 * the leading trim stops at is the star of a "*.ext" glob, a star with a "."
 * right after it: "'*.pem'." trims to "*.pem", never to ".pem" (the
 * c5532a3 review's M1, where no form of the word was the glob any more).
 */
function trimEdges(word: string): string {
  const chars = [...word];
  let start = 0;
  let end = chars.length;
  const trimmable = (c: string, keep: Set<string>): boolean => EDGE_CHAR_RE.test(c) && !keep.has(c);
  const globStar = (i: number): boolean => chars[i] === "*" && chars[i + 1] === ".";
  while (start < end && trimmable(chars[start], KEEP_LEADING) && !globStar(start)) start++;
  while (end > start && trimmable(chars[end - 1], KEEP_TRAILING)) end--;
  return chars.slice(start, end).join("");
}

/** The single-step reductions of one form of a word. */
function reductions(form: string): string[] {
  const out: string[] = [];
  // A Windows path is a path: "src\Dockerfile", ".\Dockerfile".
  if (form.includes("\\")) out.push(form.replace(/\\/g, "/"));
  const link = form.match(LINK_RE);
  if (link) out.push(link[1], link[2]);
  out.push(form.replace(LEADING_PATH_RE, ""));
  out.push(form.replace(TRAILING_MARKER_RE, ""));
  out.push(trimEdges(form));
  const glob = form.match(STARRED_GLOB_RE);
  if (glob) out.push(`*${glob[1]}`);
  // One layer of paired emphasis. A dunder ("__init__.py") is also bold
  // markdown ("__Makefile__"), and the text cannot say which, so this form
  // and the form it came from are both kept.
  out.push(stripEmphasisOnce(form));
  // Emphasis inside a word: CommonMark reads "**Docker**file" and
  // "Docker*file*" as one word with a bold or italic part, which EMPHASIS_RE
  // (a pair off word boundaries) does not remove. A star touching a letter
  // or digit is never part of a file name, so every star goes. Underscores
  // are not treated this way: inside a word they belong to an identifier.
  if (/\*[A-Za-z0-9]|[A-Za-z0-9]\*/.test(form)) out.push(form.replace(/\*+/g, ""));
  return out;
}

/**
 * Every form a word of a rule takes on its way to the bare name. From the
 * word as written, each reduction is applied to each form found so far until
 * no new form appears, and every form is a candidate: Windows backslashes
 * read as slashes; a markdown link's text and target; leading "./", "../" or
 * a lone "/"; a trailing footnote or reference marker; Unicode punctuation,
 * symbol and format characters trimmed from both ends (EDGE_CHAR_RE, but
 * never a glob's own star); a "*.ext" glob out of its emphasis stars; one
 * layer of paired emphasis; and the stars of emphasis inside a word. Every
 * intermediate form is kept, so a later reduction never discards a form an
 * earlier one reached; but a name is matched only if some chain of
 * reductions reaches it exactly, which is what the property tests in
 * file-name-rule.test.ts check for each protected name and glob. An
 * underscore inside an identifier is never emphasis (EMPHASIS_RE requires a
 * non-alphanumeric character on both sides).
 */
function wordForms(raw: string): string[] {
  const forms = new Set<string>();
  const queue = [raw];
  while (queue.length > 0 && forms.size < MAX_WORD_FORMS) {
    const form = queue.shift() as string;
    if (forms.has(form)) continue;
    forms.add(form);
    for (const next of reductions(form)) {
      if (next && !forms.has(next)) queue.push(next);
    }
  }
  forms.delete("");
  return [...forms];
}

const MULTIWORD_EMPHASIS_MARKERS = ["***", "___", "**", "__", "*", "_"];
// Layers of nested emphasis or HTML elements removed from a whole rule.
// Real rules nest two or three deep; the cap keeps a crafted rule linear.
const MAX_NESTING_PASSES = 16;

const isAsciiAlnum = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);
const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * One pass of `marker` emphasis whose content holds whitespace removed: it
 * spans words ("**Never touch the Dockerfile.**"). A marker opens off a word
 * boundary, not beside another of its own character and not before
 * whitespace, and closes the same way mirrored, so the underscores of
 * "__init__.py" inside "_Never edit __init__.py_" are not a close. Each open
 * takes the first valid close after the first whitespace of its content,
 * which is what a lazy regex would take, found with a single linear scan
 * (the regex this replaces was cubic in the rule's length).
 */
function stripMultiwordOnce(text: string, marker: string): string {
  const c = marker[0];
  const n = marker.length;
  const opens: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i + n <= text.length; i++) {
    if (!text.startsWith(marker, i)) continue;
    const before = i > 0 ? text[i - 1] : "";
    const after = i + n < text.length ? text[i + n] : "";
    if (!(before && (isAsciiAlnum(before) || before === c)) && after && !isSpace(after) && after !== c) {
      opens.push(i);
    }
    if (before && !isSpace(before) && before !== c && !(after && (isAsciiAlnum(after) || after === c))) {
      closes.push(i);
    }
  }
  if (opens.length === 0 || closes.length === 0) return text;
  // nextSpace[i]: the first whitespace at or after i, or -1.
  const nextSpace = new Array<number>(text.length + 1).fill(-1);
  for (let i = text.length - 1; i >= 0; i--) nextSpace[i] = isSpace(text[i]) ? i : nextSpace[i + 1];
  let out = "";
  let last = 0;
  let ci = 0;
  for (const open of opens) {
    if (open < last) continue;
    const space = nextSpace[open + n];
    if (space === -1) break;
    while (ci < closes.length && closes[ci] <= space) ci++;
    if (ci >= closes.length) break;
    const close = closes[ci++];
    out += text.slice(last, open) + text.slice(open + n, close);
    last = close + n;
  }
  return out + text.slice(last);
}

/**
 * `text` with emphasis that spans more than one word removed, layer by
 * layer until stable or MAX_NESTING_PASSES. Single-word emphasis is left to
 * wordForms, which keeps both readings of a dunder.
 */
function stripMultiwordEmphasis(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_NESTING_PASSES; pass++) {
    let next = out;
    for (const marker of MULTIWORD_EMPHASIS_MARKERS) next = stripMultiwordOnce(next, marker);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * The readings of a whole rule the words are taken from: as written (a
 * backslash may be a Windows path), with markdown backslash escapes undone
 * ("payment\_methods" is payment_methods), and with HTML tags removed as
 * well (every tag, and separately only paired ones); each of those also
 * with emphasis that spans words removed. The escape is undone before any
 * backslash is read as a slash, so an escaped underscore never becomes a
 * path separator.
 */
function ruleReadings(rule: string): string[] {
  const unescaped = rule.replace(MARKDOWN_ESCAPE_RE, "$1");
  const tagless = unescaped.replace(HTML_TAG_RE, " ");
  let pairless = unescaped;
  for (let pass = 0; pass < MAX_NESTING_PASSES; pass++) {
    const next = pairless.replace(HTML_ELEMENT_RE, " $2 ");
    if (next === pairless) break;
    pairless = next;
  }
  const readings = new Set<string>();
  for (const text of [rule, unescaped, tagless, pairless]) {
    readings.add(text);
    readings.add(stripMultiwordEmphasis(text));
  }
  return [...readings];
}

/** The candidate words of a rule as written, each in every form wordForms reduces it through. */
function ruleWords(rule: string): string[] {
  const words = new Set<string>();
  for (const reading of ruleReadings(rule)) {
    for (const word of reading.split(/\s+/)) {
      if (!word || words.has(word)) continue;
      for (const form of wordForms(word)) words.add(form);
    }
  }
  return [...words];
}

/**
 * The closed file-name rule. A word of the rule names a changed file when
 * one of its forms (wordForms) is exactly that file's basename
 * (".env.local", "CODEOWNERS", "Dockerfile", "id_rsa"), or exactly the
 * basename without its final extension ("CHANGELOG" for CHANGELOG.md, ".env"
 * for .env.local, "secrets" for secrets.json), or a "*.ext" word whose
 * extension ends the basename ("*.pem" for server.pem). Case-sensitive. Such
 * a match is a path match, so the file-name tokens it rests on count.
 * Nothing else about a file name is: a bare word found inside a name ("sync"
 * in SyncStatus.tsx) is not.
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

// Characters that make a neighbour part of the same name for the safety
// net: letters, digits, "_", "-" and path separators on either side, and
// "." on the left (x.Dockerfile is another file; Dockerfile. ends a
// sentence).
const NET_NAME_CHAR_RE = /[\p{L}\p{N}_\-/\\]/u;

/** Text folded for the safety net: compatibility forms, no format characters, no markdown escapes, lower case. */
function foldForNet(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(MARKDOWN_ESCAPE_RE, "$1")
    .toLowerCase();
}

/**
 * A safety net under namesChangedFile: true when a changed file's whole
 * basename, extension included, appears in the rule as a name of its own,
 * ignoring case, format characters (a zero-width space, a soft hyphen) and
 * markdown escapes, whatever punctuation surrounds it. It never matches a
 * basename without its extension ("billing" is not Billing.tsx: ruled
 * case-sensitive), a name inside a longer name, or a name behind a path
 * separator (~/Dockerfile, infra/Dockerfile). drift.ts uses it only to stop
 * the file-name-only demotion, which runs only on a match the tokens already
 * made, so it cannot create a block that 1.9.0 did not have.
 */
export function mentionsChangedBasename(rule: string, changedPaths: string[]): boolean {
  const text = foldForNet(rule);
  for (const path of changedPaths) {
    const base = foldForNet(path.replace(/\\/g, "/").split("/").pop() ?? "");
    if (!base) continue;
    for (let at = text.indexOf(base); at !== -1; at = text.indexOf(base, at + 1)) {
      const before = at > 0 ? text[at - 1] : "";
      const after = text.slice(at + base.length, at + base.length + 1);
      if (before && (NET_NAME_CHAR_RE.test(before) || before === ".")) continue;
      if (after && NET_NAME_CHAR_RE.test(after)) continue;
      return true;
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
