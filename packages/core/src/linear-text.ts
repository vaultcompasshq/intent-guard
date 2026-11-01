// Linear-time replacements for regular expressions that backtracked
// polynomially (CodeQL js/polynomial-redos). The text these read comes from a
// diff, a spec, or a file an agent wrote, which is untrusted input for a gate:
// a pattern that takes seconds on a crafted line is a way to stall the gate.
//
// Each function here reproduces the match its regular expression made,
// including the edge cases (a line separator inside a line, untrimmed input),
// and tests/linear-text.test.ts checks that against the original pattern on
// generated strings. Positions are UTF-16 code units, as they are for a
// regular expression without the u flag.

const WHITESPACE_RE = /\s/;

/** True for a code unit that `\s` matches. */
export function isRegexWhitespace(ch: string): boolean {
  return WHITESPACE_RE.test(ch);
}

// Written as code points so they are visible in review: U+2028 LINE
// SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** True for a code unit that `.` does not match (without the s flag). */
export function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === LINE_SEPARATOR || ch === PARAGRAPH_SEPARATOR;
}

/**
 * `text` without its longest suffix made only of code units in `chars` (and,
 * when `whitespace` is set, of code units `\s` matches). The same result as
 * `text.replace(/[chars]+$/, "")`, in one backward pass.
 */
export function trimTrailing(text: string, chars: string, whitespace = false): string {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (chars.includes(ch) || (whitespace && isRegexWhitespace(ch))) end--;
    else break;
  }
  return end === text.length ? text : text.slice(0, end);
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isRegexWhitespace(text[i])) i++;
  return i;
}

function skipWhitespaceBack(text: string, end: number): number {
  let i = end;
  while (i > 0 && isRegexWhitespace(text[i - 1])) i--;
  return i;
}

function hasLineTerminator(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (isLineTerminator(text[i])) return true;
  return false;
}

const FRAGMENT_RUN_RE = /[A-Za-z0-9._/-]+/g;

/**
 * Every match of `/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)+/g` in `text`.
 *
 * A match lies inside one maximal run of those characters plus "/". It
 * starts at the run's first character that is not a slash, needs a slash
 * somewhere after that, and then runs to the end of the run. So the run is
 * found first and checked once, rather than retried from every position.
 */
export function slashFragmentMatches(text: string): string[] {
  const out: string[] = [];
  for (const run of text.matchAll(FRAGMENT_RUN_RE)) {
    const value = run[0];
    let start = 0;
    while (start < value.length && value[start] === "/") start++;
    if (value.indexOf("/", start) !== -1) out.push(value.slice(start));
  }
  return out;
}

/** The same result as `text.replace(/\s*\([^)]*\)\s*$/, "")`. */
export function stripTrailingParenthetical(text: string): string {
  const end = skipWhitespaceBack(text, text.length);
  if (end === 0 || text[end - 1] !== ")") return text;
  const close = end - 1;
  // The opening bracket is the first "(" after any earlier ")".
  const previousClose = close === 0 ? -1 : text.lastIndexOf(")", close - 1);
  const open = text.indexOf("(", previousClose + 1);
  if (open === -1 || open >= close) return text;
  return text.slice(0, skipWhitespaceBack(text, open));
}

/** The same result as `text.replace(/\s*:\s*$/, "")`. */
export function stripTrailingColon(text: string): string {
  const end = skipWhitespaceBack(text, text.length);
  if (end === 0 || text[end - 1] !== ":") return text;
  return text.slice(0, skipWhitespaceBack(text, end - 1));
}

/** What `/^(#{1,6})\s+(.+?)\s*#*\s*$/` captured: the hashes and the title. */
export function matchAtxHeading(line: string): { hashes: string; title: string } | null {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level < 1 || level > 6) return null;
  if (level >= line.length || !isRegexWhitespace(line[level])) return null;
  const hashes = line.slice(0, level);

  const titleStart = skipWhitespace(line, level);
  if (titleStart === line.length) {
    // Nothing but whitespace after the hashes: the title is the last of that
    // whitespace that "." can match, with at least one character left for
    // the "\s+" in front of it.
    for (let i = line.length - 1; i > level; i--) {
      if (!isLineTerminator(line[i])) return { hashes, title: line[i] };
    }
    return null;
  }

  // The title is as short as it can be, so the closing "\s*#*\s*" takes the
  // longest suffix of that shape, leaving at least one title character.
  let suffix = skipWhitespaceBack(line, line.length);
  while (suffix > 0 && line[suffix - 1] === "#") suffix--;
  suffix = skipWhitespaceBack(line, suffix);
  const titleEnd = Math.max(titleStart + 1, suffix);
  if (hasLineTerminator(line, titleStart, titleEnd)) return null;
  return { hashes, title: line.slice(titleStart, titleEnd) };
}

function boldDelimiter(line: string): string | null {
  const delimiter = line.slice(0, 2);
  return delimiter === "**" || delimiter === "__" ? delimiter : null;
}

/** What `/^(\*\*|__)(.+?)\1\s*:?\s*$/` captured: the delimiter and the title. */
export function matchBoldHeading(line: string): { delimiter: string; title: string } | null {
  const delimiter = boldDelimiter(line);
  if (delimiter === null) return null;
  // The closing delimiter must end exactly where the longest trailing
  // "\s*:?\s*" begins: that suffix holds no "*" or "_", and everything after
  // the delimiter must be inside it.
  let tail = skipWhitespaceBack(line, line.length);
  if (tail > 0 && line[tail - 1] === ":") tail--;
  tail = skipWhitespaceBack(line, tail);
  if (tail < 5 || line.slice(tail - 2, tail) !== delimiter) return null;
  if (hasLineTerminator(line, 2, tail - 2)) return null;
  return { delimiter, title: line.slice(2, tail - 2) };
}

/**
 * What `/^(\*\*|__)(.+?)\1\s*:?\s+(.+)$/` captured: the delimiter, the label
 * and the text after it. The label is the shortest one whose closing
 * delimiter is followed by a tail the rest of the pattern accepts, and the
 * tail is checked with the pattern's own backtracking order.
 */
export function matchBoldLabel(
  line: string,
): { delimiter: string; label: string; rest: string } | null {
  const delimiter = boldDelimiter(line);
  if (delimiter === null) return null;
  // The rest, "(.+)$", is any non-empty suffix holding no line terminator:
  // one starting at or after restFloor.
  let restFloor = 0;
  let firstTerminator = line.length;
  for (let i = 0; i < line.length; i++) {
    if (!isLineTerminator(line[i])) continue;
    restFloor = i + 1;
    if (i >= 2 && firstTerminator === line.length) firstTerminator = i;
  }
  const last = line.length - 1;

  const restAfter = (from: number): number => {
    const afterSpace = skipWhitespace(line, from);
    // "\s*" takes all of the leading whitespace and ":" matches.
    if (afterSpace < line.length && line[afterSpace] === ":") {
      const afterColonSpace = skipWhitespace(line, afterSpace + 1);
      if (afterColonSpace > afterSpace + 1) {
        const rest = Math.min(afterColonSpace, last);
        if (rest >= afterSpace + 2 && rest >= restFloor) return rest;
      }
    }
    // No colon: "\s*" gives whitespace back to "\s+".
    if (afterSpace > from) {
      const rest = Math.min(afterSpace, last);
      if (rest >= from + 1 && rest >= restFloor) return rest;
    }
    return -1;
  };

  for (let close = line.indexOf(delimiter, 3); close !== -1; close = line.indexOf(delimiter, close + 1)) {
    // The label is "(.+?)": once it would hold a terminator, no longer
    // label can match either.
    if (close > firstTerminator) return null;
    const rest = restAfter(close + 2);
    if (rest !== -1) {
      return { delimiter, label: line.slice(2, close), rest: line.slice(rest) };
    }
  }
  return null;
}
