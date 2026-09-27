import type { ChangeBudget } from "@vaultcompass/intent-guard-schema";

export type BudgetPathRule = "protected_paths" | "allowed_paths";

export interface BudgetPathIssue {
  rule: BudgetPathRule;
  value: string;
  reason: string;
}

/**
 * The single source of truth for what a `protected_paths` or `allowed_paths`
 * entry is allowed to look like. Both rules share one matcher
 * (`matchesGlob` in budget.ts), so they share one set of validity rules too.
 *
 * A value has to already look like a glob the matcher can evaluate:
 * relative (the gate compares against git-relative changed paths, so a
 * leading slash could never match anything), without a '..' segment (a
 * budget meant to protect or scope a path has no business climbing out of
 * the project), and not itself another flag when it arrives on a command
 * line (a value starting with '-' would otherwise be swallowed as the glob
 * while the flag it looks like silently never takes effect). A backslash,
 * surrounding whitespace, or a stray '.' segment (anywhere but a leading
 * './') are all rejected too: none of them are meaningful in a glob the
 * gate evaluates, and each is more likely a mistake than an intentional
 * pattern. Brace groups (`{a,b}`) and character classes (`[abc]`) are
 * rejected as well: budget.ts's matchesGlob escapes `{ } [ ]` as literal
 * characters rather than expanding them, so a path like
 * `src/{legacy,vendor}/**` would pass a looser check, get frozen into a
 * contract, and then never match anything at gate time.
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
  if (value.startsWith("-")) {
    return "must not start with '-' (it would be read as a flag)";
  }
  if (value.startsWith("/")) {
    return "must not start with '/' (paths are matched git-relative; a leading slash can never match)";
  }
  if (value.includes("\\")) {
    return "must not contain a backslash";
  }
  if (/[{}[\]]/.test(value)) {
    return "must not contain '{', '}', '[', or ']' (the matcher treats brace groups and character classes as literal characters, not as wildcards)";
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
 * Validates every `protected_paths` and `allowed_paths` entry of a budget
 * block and returns one issue per offending entry, each naming which rule
 * it came from, the exact value, and the reason. An absent budget, or a
 * budget with neither list, returns an empty array.
 *
 * This is the check every writer of a budget block has to run before that
 * block is trusted: `intent-guard extract` (the command-line flag),
 * `intent-guard import-spec` (a fenced yaml block in a spec), and
 * `intent-guard freeze` (a hand-edited draft). It is also the check
 * `intent-guard check` / `intent-guard report` run against an
 * already-frozen contract, because a contract written before this
 * validator existed, or edited by hand after freezing, can still carry an
 * entry that matches nothing.
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
