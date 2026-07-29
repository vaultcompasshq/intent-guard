import type { ChangeBudget, IntentContract } from "@vaultcompass/conductor-schema";

export type BudgetRule =
  | "protected_paths"
  | "allowed_paths"
  | "max_files"
  | "allow_new_dependencies";

export type BudgetSeverity = "soft_block" | "hard_block";

export interface BudgetViolation {
  rule: BudgetRule;
  severity: BudgetSeverity;
  message: string;
  /** Changed paths (or values) responsible for the violation. */
  matched: string[];
}

export interface BudgetResult {
  ok: boolean;
  action: "ok" | "soft_block" | "hard_block";
  violations: BudgetViolation[];
}

/** Manifest/lockfile paths whose edit implies a dependency change. */
const MANIFEST_RE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pyproject\.toml|requirements\.txt|poetry\.lock|gemfile|gemfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle|gradle\.lockfile)$/i;

function isManifestPath(path: string): boolean {
  return MANIFEST_RE.test(path.toLowerCase());
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal, dependency-free glob matcher. Supports:
 *   `**` — any number of path segments (including zero)
 *   `*`  — any run of characters within a single segment
 *   `?`  — a single character within a segment
 * Matching is anchored to the whole path and case-sensitive.
 */
export function matchesGlob(path: string, glob: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` spans any number of path segments.
        i++;
        const slashBefore = re === "" || re.endsWith("/");
        const slashAfter = glob[i + 1] === "/";
        if (slashAfter) i++;
        // Between two slashes it may match zero or more whole segments;
        // otherwise (e.g. a trailing `/**`) it matches the rest of the path.
        re += slashBefore && slashAfter ? "(?:.*/)?" : ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/**
 * Evaluate a contract's change budget against the set of changed paths.
 * Deterministic and path-only: no file contents, no network, no model.
 * `protected_paths` breaches hard_block; every other rule soft_blocks.
 */
export function evaluateBudget(
  contract: IntentContract,
  changedPaths: string[],
): BudgetResult {
  const budget: ChangeBudget | undefined = contract.budget;
  const violations: BudgetViolation[] = [];

  if (!budget || changedPaths.length === 0) {
    return { ok: true, action: "ok", violations };
  }

  if (budget.protected_paths && budget.protected_paths.length > 0) {
    const matched = changedPaths.filter((p) =>
      matchesAny(p, budget.protected_paths!),
    );
    if (matched.length > 0) {
      violations.push({
        rule: "protected_paths",
        severity: "hard_block",
        message: `Touched protected path(s): ${matched.join(", ")}`,
        matched,
      });
    }
  }

  if (budget.allowed_paths && budget.allowed_paths.length > 0) {
    const matched = changedPaths.filter(
      (p) => !matchesAny(p, budget.allowed_paths!),
    );
    if (matched.length > 0) {
      violations.push({
        rule: "allowed_paths",
        severity: "soft_block",
        message: `Changed path(s) outside allowed_paths: ${matched.join(", ")}`,
        matched,
      });
    }
  }

  if (typeof budget.max_files === "number") {
    if (changedPaths.length > budget.max_files) {
      violations.push({
        rule: "max_files",
        severity: "soft_block",
        message: `Changed ${changedPaths.length} files, budget allows ${budget.max_files}`,
        matched: changedPaths,
      });
    }
  }

  if (budget.allow_new_dependencies === false) {
    const matched = changedPaths.filter(isManifestPath);
    if (matched.length > 0) {
      violations.push({
        rule: "allow_new_dependencies",
        severity: "soft_block",
        message: `Edited dependency manifest(s) while allow_new_dependencies is false: ${matched.join(", ")}`,
        matched,
      });
    }
  }

  const action = violations.some((v) => v.severity === "hard_block")
    ? "hard_block"
    : violations.length > 0
      ? "soft_block"
      : "ok";

  return { ok: violations.length === 0, action, violations };
}
