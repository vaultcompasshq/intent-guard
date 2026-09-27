import type { ChangeBudget } from "@vaultcompass/intent-guard-schema";

export type BudgetPathRule = "protected_paths" | "allowed_paths";

export interface BudgetPathIssue {
  rule: BudgetPathRule;
  value: string;
  reason: string;
}

/**
 * Contract-level rules: what a `protected_paths` or `allowed_paths` entry
 * has to look like once it is IN a contract, whether written by extract,
 * import-spec, a hand edit, or already frozen. Both rules share one matcher
 * (`matchesGlob` in budget.ts), so they share one set of validity rules too.
 *
 * A value has to already look like a glob the matcher can evaluate:
 * relative (the gate compares against git-relative changed paths, so a
 * leading slash could never match anything), without a '..' segment (a
 * budget meant to protect or scope a path has no business climbing out of
 * the project), and without a stray '.' or empty segment -- `./` alone
 * normalizes to nothing, and `src//x` has an empty segment -- since either
 * one is a glob no real git path can ever match. A backslash or surrounding
 * whitespace are rejected too, for the same reason: neither is meaningful in
 * a glob the gate evaluates.
 *
 * A leading '-', a brace group (`{a,b}`), and a character class (`[abc]`)
 * are deliberately NOT rejected here, even though budget.ts's matchesGlob
 * treats `{ } [ ]` as literal characters rather than expanding them: a real
 * git path can and does contain them. `app/[slug]/**` is a Next.js or
 * SvelteKit dynamic-route directory literally named `[slug]`, and
 * `-legacy/**` is a directory that happens to start with a dash. Rejecting
 * either here would block a contract from protecting a path that exists.
 * The tighter, flag-only rule that DOES reject them lives in
 * validateProtectedPathFlag below.
 *
 * Returns null when the value is valid, or a human-readable reason when it
 * is not. The reason never repeats the offending value: callers already
 * have it and compose their own message around it (see
 * describeBudgetPathIssue below).
 */
export function validateBudgetGlob(value: string): string | null {
  if (value.trim().length === 0) {
    return "must not be empty or whitespace-only";
  }
  if (value !== value.trim()) {
    return "must not have leading or trailing whitespace";
  }
  if (value.startsWith("/")) {
    return "must not start with '/' (paths are matched git-relative; a leading slash can never match)";
  }
  if (value.includes("\\")) {
    return "must not contain a backslash";
  }
  if (value === "./") {
    return "must not be just './' (that normalizes to nothing and cannot match any path)";
  }
  // Trailing slashes are stripped before this check, not before any other:
  // budget.ts's matchesGlob does the same (`/\/+$/`) for a no-wildcard glob,
  // so `src//` is exactly as working a prefix as `src` or `src/`. Only an
  // INTERNAL empty segment -- `src//x` -- is a glob no real git path (which
  // never contains one) can ever match.
  if (value.replace(/\/+$/, "").includes("//")) {
    return "must not contain an empty path segment (consecutive '/')";
  }
  const segments = value.split("/");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "..") {
      return "must not contain a '..' segment";
    }
    if (segments[i] === "." && (i !== 0 || segments.length === 1)) {
      return "must not contain a '.' segment except a leading './'";
    }
  }
  return null;
}

/**
 * Flag-level rules: `intent-guard extract --protected-path` only. A
 * superset of the contract-level rules above, plus two checks that only
 * make sense on a command line rather than inside an already-written
 * contract: a value starting with '-' would otherwise be swallowed as the
 * glob while the flag it looks like (most concretely `--protected-path
 * --dry-run`) silently never takes effect, and a brace group or character
 * class is far more likely a mistaken attempt at shell-style expansion,
 * typed straight into a flag, than a deliberate literal match -- unlike a
 * value that already made it into a contract, which import-spec or a human
 * had a chance to review first.
 */
export function validateProtectedPathFlag(value: string): string | null {
  const contractIssue = validateBudgetGlob(value);
  if (contractIssue) return contractIssue;
  if (value.startsWith("-")) {
    return "must not start with '-' (it would be read as a flag)";
  }
  if (/[{}[\]]/.test(value)) {
    return "must not contain '{', '}', '[', or ']' (the matcher treats brace groups and character classes as literal characters, not as wildcards)";
  }
  return null;
}

/**
 * Validates every `protected_paths` and `allowed_paths` entry of a budget
 * block against the CONTRACT-level rules (validateBudgetGlob, not the
 * flag-only validateProtectedPathFlag) and returns one issue per offending
 * entry, each naming which rule it came from, the exact value, and the
 * reason. An absent budget, or a budget with neither list, returns an empty
 * array.
 *
 * This is the check every writer of a budget block already IN a contract
 * has to run before that block is trusted: `intent-guard import-spec` (a
 * fenced yaml block in a spec) and `intent-guard freeze` (a hand-edited
 * draft). It is also the check `intent-guard check` / `intent-guard report`
 * run against an already-frozen contract, because a contract written before
 * this validator existed, or edited by hand after freezing, can still carry
 * an entry that matches nothing. `intent-guard extract --protected-path`
 * uses the stricter validateProtectedPathFlag directly instead, since a
 * value typed on a command line gets the tighter, flag-only rules.
 */
export function validateBudgetPaths(
  budget: Pick<ChangeBudget, "protected_paths" | "allowed_paths"> | null | undefined,
): BudgetPathIssue[] {
  if (!budget) return [];
  const issues: BudgetPathIssue[] = [];
  for (const value of budget.protected_paths ?? []) {
    const reason = validateBudgetGlob(value);
    if (reason) issues.push({ rule: "protected_paths", value, reason });
  }
  for (const value of budget.allowed_paths ?? []) {
    const reason = validateBudgetGlob(value);
    if (reason) issues.push({ rule: "allowed_paths", value, reason });
  }
  return issues;
}

/** Renders one issue as a single line: the rule, the value, and the reason. */
export function describeBudgetPathIssue(issue: BudgetPathIssue): string {
  return `${issue.rule} entry '${issue.value}' is invalid: ${issue.reason}`;
}

/** Renders every issue, one per line, for use in an error message. */
export function describeBudgetPathIssues(issues: BudgetPathIssue[]): string {
  return issues.map(describeBudgetPathIssue).join("\n");
}
