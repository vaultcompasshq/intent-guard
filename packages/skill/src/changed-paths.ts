/**
 * Shared changed-path collection for the gate CLIs (`check` and `report`).
 *
 * Both commands feed the same gate, so they must see the same paths for the
 * same flags. Keeping the collection here is the only way to guarantee that:
 * the two CLIs used to carry their own copy of the staged helper and were
 * already one edit away from disagreeing.
 */

import { execFileSync } from "node:child_process";
import { gitSpawnEnv } from "@vaultcompass/intent-guard-core";

export interface ChangedPathOptions {
  projectRoot: string;
  /** Paths named explicitly with --paths. */
  paths: string[];
  /** Add the git index (--staged). */
  staged: boolean;
  /** Add everything changed since the merge base with this ref (--base). */
  base: string;
}

/**
 * Split `git ... -z` output. NUL is the only separator git never quotes or
 * escapes: without -z, git C-quotes any path holding a double quote, backslash,
 * tab or newline (core.quotePath=false does not stop that), so a file named
 * secrets/a"b.txt reached the budget as "secrets/a\"b.txt" and matched no glob.
 * No trimming either: a trailing space is part of the name.
 */
function splitPaths(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
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
 * execFileSync defaults to a 1 MB output buffer, and a bigger name list throws
 * ENOBUFS. That used to be swallowed into an empty list, which passes. 256 MB
 * is far past any real change set.
 */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Paths in the git index.
 *
 * Only "not a git repository" yields an empty list: --staged is used from a
 * pre-commit hook and a directory that is not a repository has nothing staged.
 * Every other failure (a corrupt index, an oversized listing, a git that will
 * not spawn) exits 2 like --base does, because an empty list makes the gate
 * pass.
 */
export function stagedPaths(projectRoot: string): string[] {
  // Detected explicitly, up front: outside a repository `git diff --cached`
  // does not say "not a git repository", it falls into --no-index mode and
  // complains about the flag.
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: projectRoot,
      env: gitSpawnEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const reason = gitFailureReason(error);
    if (/not a git repository/i.test(reason)) return [];
    console.error(`intent-guard: cannot list staged paths (--staged): ${reason}`);
    process.exit(2);
  }
  try {
    // core.quotePath=false keeps unicode/space paths literal instead of
    // octal-escaped and quoted, so budget globs match the real path.
    // --no-renames lists both sides of a rename, so moving a file out of a
    // protected directory still names the protected path. See basePaths, also
    // for --ignore-submodules=none.
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--cached",
        "--no-renames",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
      ],
      {
        cwd: projectRoot,
        env: gitSpawnEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    return splitPaths(out);
  } catch (error) {
    const reason = gitFailureReason(error);
    if (/not a git repository/i.test(reason)) return [];
    console.error(`intent-guard: cannot list staged paths (--staged): ${reason}`);
    process.exit(2);
  }
}

/**
 * Why an explicit --paths entry is refused, or null. The shapes mirror what
 * validateBudgetGlob refuses in a glob: the budget matches the string it is
 * given, so each of these can name a protected file the globs never match.
 * A real git path has none of them, except that a backslash is a legal file
 * name character; it is refused here only because the caller typed it, and
 * paths that come from git (--staged, --base) are never subject to this.
 * A single leading "./" and trailing slashes are accepted, as in a glob.
 */
function explicitPathIssue(path: string): string | null {
  if (path.startsWith("/")) return "it starts with '/' (paths are project-relative)";
  if (path.includes("\\")) return "it contains a backslash";
  const withoutLead = path.replace(/^\.\//, "");
  const trimmed = withoutLead.replace(/\/+$/, "");
  if (trimmed === "") return "it names nothing (only './' or slashes)";
  if (withoutLead.startsWith("/")) return "it contains an empty segment (consecutive '/')";
  if (trimmed.includes("//")) return "it contains an empty segment (consecutive '/')";
  for (const segment of trimmed.split("/")) {
    if (segment === "..") return 'it contains a ".." segment';
    if (segment === ".") return "it contains a '.' segment";
  }
  return null;
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
 * --ignore-submodules=none because `ignore = all` for a submodule, set in
 * .gitmodules (which the change itself can edit) or in git config, leaves a
 * moved submodule pointer out of a plain diff. The command-line value
 * overrides both.
 *
 * Fail-closed. An unknown ref, a missing repository, a shallow clone with no
 * merge base, or a git that will not spawn all exit 2 rather than yielding an
 * empty set, because an empty set makes the gate pass and this gate exists to
 * block.
 */
export function basePaths(projectRoot: string, baseRef: string): string[] {
  // Refused here, inside the function that calls git, so no caller can skip
  // it. Git reads "-Sxyz...HEAD" as a pickaxe option rather than a range and
  // lists nothing, and an empty list passes. Exit 2, could-not-run, like an
  // unknown ref. Not --end-of-options: older gits do not all accept it.
  if (baseRef.startsWith("-")) {
    console.error(
      `intent-guard: refusing base ref "${baseRef}": it starts with a dash, so git would read it as an option rather than a revision. Nothing was checked.`,
    );
    process.exit(2);
  }
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-renames",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
        `${baseRef}...HEAD`,
        // Ends the revisions. Without it a file named exactly like the range
        // makes git refuse with "ambiguous argument", and the run exits 2.
        "--",
      ],
      {
        cwd: projectRoot,
        env: gitSpawnEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: GIT_MAX_BUFFER,
      },
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
  // Refused, not normalized: the budget matches globs against the string it is
  // given, so `src/../secrets/k` never matched `secrets/**` while naming a
  // protected file, and neither did `././secrets/k`, `secrets//k` or
  // `/secrets/k`. A real git path has none of these shapes, so a caller that
  // sends one is either buggy or probing, and exit 2 says which.
  for (const path of options.paths) {
    const issue = explicitPathIssue(path);
    if (issue) {
      console.error(
        `intent-guard: refusing changed path "${path}": ${issue}, so the budget globs may not match the file it names. Pass the path relative to the project root in its plain form.`,
      );
      process.exit(2);
    }
  }

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
