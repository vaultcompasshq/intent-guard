/**
 * Shared changed-path collection for the gate CLIs (`check` and `report`).
 *
 * Both commands feed the same gate, so they must see the same paths for the
 * same flags. Keeping the collection here is the only way to guarantee that:
 * the two CLIs used to carry their own copy of the staged helper and were
 * already one edit away from disagreeing.
 */

import { execFileSync } from "node:child_process";

export interface ChangedPathOptions {
  projectRoot: string;
  /** Paths named explicitly with --paths. */
  paths: string[];
  /** Add the git index (--staged). */
  staged: boolean;
  /** Add everything changed since the merge base with this ref (--base). */
  base: string;
}

function splitPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * One line, the way the docs promise. Git is happy to answer a bad invocation
 * with its whole usage screen (128 lines outside a repository), and burying the
 * ref that failed under that is worse than saying nothing: the first line is
 * the reason, the rest is manual.
 */
function gitFailureReason(error: unknown): string {
  const raw = (error as { stderr?: string | Buffer }).stderr;
  const fromGit = typeof raw === "string" ? raw : raw ? raw.toString("utf8") : "";
  const firstLine = fromGit
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return firstLine;
  return error instanceof Error ? error.message.split("\n")[0].trim() : String(error);
}

/**
 * Paths in the git index.
 *
 * The silent catch predates --base and is deliberately left alone in this
 * release: --staged is used from a pre-commit hook where an empty index and a
 * missing repo are both ordinary. --base does not copy this behavior.
 */
export function stagedPaths(projectRoot: string): string[] {
  try {
    // core.quotePath=false keeps unicode/space paths literal instead of
    // octal-escaped and quoted, so budget globs match the real path.
    // --no-renames lists both sides of a rename, so moving a file out of a
    // protected directory still names the protected path. See basePaths.
    const out = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--cached", "--no-renames", "--name-only"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    return splitPaths(out);
  } catch {
    return [];
  }
}

/**
 * Paths changed since the merge base of `baseRef` and HEAD.
 *
 * Three dots, not two: a pull request is judged on what the branch added since
 * it forked, not on the difference between two tips, so commits that landed on
 * the base after the fork must not be attributed to the branch.
 *
 * --no-renames because rename detection reports only a rename's destination.
 * Moving a file out of a protected directory would otherwise never name the
 * protected path, and the budget it was meant to trip would pass. Both sides
 * are listed instead, which is why a rename counts as two paths.
 *
 * Fail-closed. An unknown ref, a missing repository, a shallow clone with no
 * merge base, or a git that will not spawn all exit 2 rather than yielding an
 * empty set, because an empty set makes the gate pass and this gate exists to
 * block.
 */
export function basePaths(projectRoot: string, baseRef: string): string[] {
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-renames",
        "--name-only",
        `${baseRef}...HEAD`,
      ],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return splitPaths(out);
  } catch (error) {
    console.error(
      `intent-guard: cannot list paths changed since base ref "${baseRef}": ${gitFailureReason(error)}`,
    );
    process.exit(2);
  }
}

/**
 * The union of every source the caller asked for, de-duplicated and left in
 * first-seen order: explicit paths, then the index, then the base ref.
 */
export function collectChangedPaths(options: ChangedPathOptions): string[] {
  const collected = [...options.paths];
  if (options.staged) collected.push(...stagedPaths(options.projectRoot));
  if (options.base) collected.push(...basePaths(options.projectRoot, options.base));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of collected) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}
