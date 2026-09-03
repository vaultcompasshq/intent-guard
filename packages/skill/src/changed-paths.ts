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
    const out = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
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
 * Fail-closed. An unknown ref, a missing repository, a shallow clone with no
 * merge base, or a git that will not spawn all exit 2 rather than yielding an
 * empty set, because an empty set makes the gate pass and this gate exists to
 * block.
 */
export function basePaths(projectRoot: string, baseRef: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", `${baseRef}...HEAD`],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return splitPaths(out);
  } catch (error) {
    const raw = (error as { stderr?: string | Buffer }).stderr;
    const fromGit = typeof raw === "string" ? raw : raw ? raw.toString("utf8") : "";
    const detail = fromGit.trim() || (error instanceof Error ? error.message : String(error));
    console.error(
      `intent-guard: cannot list paths changed since base ref "${baseRef}": ${detail}`,
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
