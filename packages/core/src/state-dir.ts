import { existsSync, lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A state directory this tool refuses to act on, described for a user rather
 * than as a stack trace: both directories present, or a symlink or plain file
 * where a directory belongs. Every one of these is a designed outcome and not
 * a crash, so the CLI entry points catch this class and print one line.
 */
export class StateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDirError";
  }
}

/**
 * Canonical directory for per-project Intent Guard state, as of 1.3.0.
 *
 * Before 1.3.0 this was `.conductor`, which is now the name of a different
 * product in the same family. A repository that adopts both would show
 * `.conductor/` and `.guardrails/` side by side with nothing to say which
 * tool owns which.
 */
export const STATE_DIR = ".intent-guard";

/** The pre-1.3.0 name. Still read, never written to. */
export const LEGACY_STATE_DIR = ".conductor";

/**
 * Entries only Intent Guard writes into its state directory. A legacy-named
 * directory is adopted only when it holds at least one of them, so a
 * `.conductor/` that belongs to something else is left untouched.
 */
const STATE_MARKERS = [
  "config.yaml",
  "intent-contract.yaml",
  "index.md",
  "drift-log.jsonl",
  "contracts",
] as const;

export interface StateDirStatus {
  /** The directory to read from: canonical unless only the legacy one exists. */
  dir: string;
  canonicalPath: string;
  legacyPath: string;
  canonicalExists: boolean;
  /** True only when the legacy directory exists AND holds Intent Guard state. */
  legacyExists: boolean;
  usingLegacy: boolean;
  /** Both directories are present, so which one is authoritative is unknowable. */
  conflict: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A real directory, not a symlink to one. `ln -s .intent-guard .conductor` is
 * the obvious workaround for a script that still names the old path, and
 * following it would make one directory look like two: the legacy path would
 * hold state, the canonical path would exist, and every command would fail
 * closed on a conflict that is not one. lstat does not follow the link, so a
 * symlink is simply not a legacy state directory.
 */
function isRealDirectory(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function holdsIntentGuardState(dir: string): boolean {
  if (!isRealDirectory(dir)) return false;
  return STATE_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/** Non-throwing view of both directories, for reporting (doctor) rather than use. */
export function inspectStateDir(projectRoot: string): StateDirStatus {
  const canonicalPath = join(projectRoot, STATE_DIR);
  const legacyPath = join(projectRoot, LEGACY_STATE_DIR);
  const canonicalExists = isDirectory(canonicalPath);
  const legacyExists = holdsIntentGuardState(legacyPath);
  const usingLegacy = legacyExists && !canonicalExists;
  return {
    dir: usingLegacy ? legacyPath : canonicalPath,
    canonicalPath,
    legacyPath,
    canonicalExists,
    legacyExists,
    usingLegacy,
    conflict: canonicalExists && legacyExists,
  };
}

function conflictError(status: StateDirStatus): StateDirError {
  // No trailing slash on the path to move, and no rm: a trailing slash through
  // a symlink makes BSD rm -rf delete the target's contents, which here would
  // be the state this message exists to protect.
  return new StateDirError(
    `Both ${status.canonicalPath} and ${status.legacyPath} exist. Intent Guard ` +
      `reads one state directory and never merges two. ${LEGACY_STATE_DIR} is ` +
      `the pre-1.3.0 name for ${STATE_DIR}: move anything you still need out ` +
      `of ${LEGACY_STATE_DIR} into ${STATE_DIR}, move ${LEGACY_STATE_DIR} ` +
      `aside, and run the command again.`,
  );
}

function describeNonDirectory(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? "a symlink" : "a file";
  } catch {
    return "not a directory";
  }
}

function notADirectoryError(path: string, kind: string): StateDirError {
  return new StateDirError(
    `Intent Guard needs ${path} to be a directory, but it is ${kind}. Move it ` +
      `aside and run the command again.`,
  );
}

const noticedRoots = new Set<string>();

/** Test seam: the legacy notice is once per process, so tests must clear it. */
export function resetStateDirNotices(): void {
  noticedRoots.clear();
}

function noticeLegacyRead(projectRoot: string): void {
  if (noticedRoots.has(projectRoot)) return;
  noticedRoots.add(projectRoot);
  process.stderr.write(
    `Intent Guard: reading project state from ${LEGACY_STATE_DIR}/, renamed to ` +
      `${STATE_DIR}/ in 1.3.0. The next write migrates it. To migrate now, run: ` +
      `git mv ${LEGACY_STATE_DIR} ${STATE_DIR}\n`,
  );
}

/**
 * The state directory to READ from. Prefers the canonical directory; falls
 * back to the legacy one, with a one-line notice per invocation. Throws when
 * both exist, because picking one would silently discard the other.
 */
export function stateDir(projectRoot: string): string {
  const status = inspectStateDir(projectRoot);
  if (status.conflict) throw conflictError(status);
  if (status.usingLegacy) noticeLegacyRead(projectRoot);
  return status.dir;
}

/**
 * The state directory to WRITE to, created if missing. Always canonical: a
 * legacy-only project is migrated first by renaming the directory, which is
 * atomic within a filesystem and carries across files this tool does not know
 * about. The rename happens only when the canonical directory does not exist.
 */
export function ensureStateDir(projectRoot: string): string {
  const status = inspectStateDir(projectRoot);
  if (status.conflict) throw conflictError(status);

  // Something that is not a directory sitting on the canonical path would come
  // out of mkdir or rename as a raw EEXIST or ENOTDIR with a stack.
  if (existsSync(status.canonicalPath) && !isDirectory(status.canonicalPath)) {
    throw notADirectoryError(status.canonicalPath, describeNonDirectory(status.canonicalPath));
  }

  if (status.usingLegacy) {
    // Re-check immediately before the rename: a concurrent process may have
    // created the canonical directory since inspectStateDir looked.
    if (existsSync(status.canonicalPath)) throw conflictError(inspectStateDir(projectRoot));
    renameSync(status.legacyPath, status.canonicalPath);
    // Git sees a rename it was not told about as a delete plus an untracked
    // directory. This tool tells people to commit the state directory, so
    // without the staging line the next `git commit -a` commits the deletion
    // of the frozen contract and nothing in its place.
    process.stderr.write(
      `Intent Guard: renamed ${LEGACY_STATE_DIR}/ to ${STATE_DIR}/ in ` +
        `${projectRoot}. Stage the rename so git records it as one: ` +
        `git add -A ${STATE_DIR} ${LEGACY_STATE_DIR}. Update .gitignore and ` +
        `any script that names the old path.\n`,
    );
  }

  mkdirSync(status.canonicalPath, { recursive: true });
  return status.canonicalPath;
}
