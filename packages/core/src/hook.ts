import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitSpawnEnv } from "./git-env.js";

/**
 * Marker written into the generated hook so install can tell its own hook from
 * a hand-written one. Deliberately NOT renamed alongside the package rename:
 * this string is state already sitting in users' repositories, and changing it
 * would make every hook this tool installed before 1.2.0 look foreign, so the
 * next install would refuse to overwrite it without --force.
 */
export const CONDUCTOR_HOOK_MARKER = "conductor-managed-pre-commit";

export interface InstallHookOptions {
  /** Also run vault-guard secret scanning in the generated hook. */
  withVaultGuard?: boolean;
  /**
   * Overwrite an existing pre-commit hook that Intent Guard did not write, or
   * a managed one that was edited after install.
   */
  force?: boolean;
  /**
   * When `core.hooksPath` points outside this repository (e.g. a machine-wide
   * `~/.git-hooks`), set local `core.hooksPath=.git/hooks` and install there
   * instead of overwriting the shared directory. Default: true.
   */
  preferLocalGitHooks?: boolean;
}

export interface InstallHookResult {
  installed: boolean;
  path: string;
  reason?: string;
  withVaultGuard: boolean;
  /** True when install rewrote local core.hooksPath to `.git/hooks`. */
  localizedHooksPath?: boolean;
  /**
   * Set with localizedHooksPath: the hooks directory core.hooksPath pointed
   * at before, as an absolute path. Its hooks no longer run in this
   * repository.
   */
  previousHooksPath?: string;
  /**
   * True when --force rewrote a managed hook that had been edited after
   * install, so the edits are gone.
   */
  discardedEdits?: boolean;
}

/**
 * Whether a hook file is one this tool wrote: its second line, right after
 * the shebang, is the managed marker header exactly. A marker anywhere else
 * (a comment in a hand-written hook that mentions it) does not count.
 */
function isManagedHook(contents: string): boolean {
  const lines = contents.split("\n");
  return lines[0]?.startsWith("#!") === true && lines[1] === `# ${CONDUCTOR_HOOK_MARKER}`;
}

/**
 * Whether a managed hook is exactly what this version renders, with or
 * without vault-guard. Anything else was edited after install, or written by
 * an older version, and is never rewritten without --force.
 */
function isUneditedManagedHook(contents: string): boolean {
  return contents === renderPreCommitHook(false) || contents === renderPreCommitHook(true);
}

/**
 * Put a hook file back as it was before install touched it: its old bytes
 * and mode, or no file at all when there was none. Best effort: install
 * reports its own failure either way.
 */
function restoreHook(hookPath: string, previous: { bytes: Buffer; mode: number } | null): void {
  try {
    if (previous === null) {
      rmSync(hookPath, { force: true });
    } else {
      writeFileSync(hookPath, previous.bytes);
      chmodSync(hookPath, previous.mode);
    }
  } catch {
    // Nothing more can be done from here.
  }
}

/**
 * Whether a hook is a managed one whose only visible difference is its line
 * endings or a byte-order mark: the header is there, read with CRLF turned
 * to LF and a leading BOM dropped. Still refused, under its own reason, so
 * the message can say what actually differs.
 */
function hasManagedHeaderWithOtherLineEndings(contents: string): boolean {
  const bom = String.fromCodePoint(0xfeff);
  const normalized = (contents.startsWith(bom) ? contents.slice(bom.length) : contents).replace(/\r\n/g, "\n");
  return normalized !== contents && isManagedHook(normalized);
}

export interface ResolvedHooksDir {
  /** Absolute directory where Git will look for hooks. */
  hooksDir: string;
  /** Display path for the pre-commit hook (repo-relative when possible). */
  displayHookPath: string;
  /** Raw `core.hooksPath` config value, or null if unset. */
  hooksPathConfig: string | null;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the directory Git uses for hooks in this repo, matching doctor.
 * Only consults `core.hooksPath` when `projectRoot` is a usable git work tree
 * (avoids inheriting a machine-wide hooksPath into bare test fixtures).
 */
export function resolveGitHooksDir(projectRoot: string): ResolvedHooksDir {
  const defaultDir = join(projectRoot, ".git", "hooks");
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectRoot,
    env: gitSpawnEnv(),
    encoding: "utf8",
  });
  if (inside.status !== 0) {
    return {
      hooksDir: defaultDir,
      displayHookPath: ".git/hooks/pre-commit",
      hooksPathConfig: null,
    };
  }

  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: projectRoot,
    env: gitSpawnEnv(),
    encoding: "utf8",
  });
  const hooksPath = result.stdout?.trim() || "";
  if (!hooksPath) {
    return {
      hooksDir: defaultDir,
      displayHookPath: ".git/hooks/pre-commit",
      hooksPathConfig: null,
    };
  }

  const hooksDir = isAbsolute(hooksPath)
    ? hooksPath
    : resolve(projectRoot, hooksPath);
  const display =
    hooksPath.endsWith("/") || hooksPath.endsWith(sep)
      ? `${hooksPath}pre-commit`
      : `${hooksPath}/pre-commit`;

  return {
    hooksDir,
    displayHookPath: display.replace(/\\/g, "/"),
    hooksPathConfig: hooksPath,
  };
}

/** Exit code the hook uses when a gate's binary is not installed. */
export const HOOK_MISSING_BINARY_EXIT = 127;

/**
 * Render a self-contained pre-commit hook. It depends only on the installed
 * CLIs (intent-guard-check, optionally vault-guard) being resolvable on PATH or
 * via npx, never on the Intent Guard repo's integrations/ directory, which does not
 * ship in the published npm packages.
 *
 * Two properties the hook is required to have:
 *
 * Fail-closed. A gate whose binary is missing is a failure, not a skip. This is
 * a guard-family hook; a hook that waves the commit through because the scanner
 * is not installed is the exact inversion of what it exists to do, and it fails
 * silently on the machine least likely to notice (a fresh clone, CI without the
 * dev dependencies). Missing binaries exit 127, the shell's own convention for
 * "command not found".
 *
 * First non-zero wins. Every gate runs even after one fails, so a single commit
 * attempt shows every problem rather than one per attempt, and each gate's own
 * exit code is printed to stderr. The hook then exits with the first non-zero
 * code it saw. A shell exit status is one integer, so some code has to be
 * chosen; taking the first means a later gate can never overwrite an earlier
 * one's code. That matters because the codes are not interchangeable: a
 * scanner's exit 2 ("could not complete, treat as blocking") says something
 * different from exit 1 ("policy violation"), and the previous last-wins
 * composition quietly downgraded the former to the latter whenever a cheaper
 * gate failed afterwards. Nothing is actually lost either way, because the
 * per-gate stderr lines report every code regardless of which one the process
 * exits with.
 */
export function renderPreCommitHook(withVaultGuard = false): string {
  const lines = [
    "#!/usr/bin/env bash",
    `# ${CONDUCTOR_HOOK_MARKER}`,
    "# Installed by: intent-guard hook install",
    "# Blocks the commit when no frozen Intent Contract exists or staged changes",
    "# drift past a blocking threshold. Bypass one commit with: git commit --no-verify",
    "#",
    "# Fail-closed: a gate whose binary is missing exits 127, it is never skipped.",
    "# Every gate runs even after an earlier one fails, and every gate's exit code",
    "# is printed below. The hook exits with the FIRST non-zero code it saw, so a",
    "# later gate cannot overwrite an earlier gate's code (exit 2 'could not",
    "# complete' means something different from exit 1 'policy violation').",
    "",
    "# No -e on purpose: every gate's exit code is captured and composed by hand,",
    "# and -e would abort the run at the first failing gate.",
    "set -uo pipefail",
    "",
    "status=0",
    "",
    "record() {",
    "  # record <gate name> <exit code>",
    '  if [ "$2" -ne 0 ]; then',
    '    echo "pre-commit: $1 exited $2" >&2',
    '    if [ "$status" -eq 0 ]; then',
    '      status="$2"',
    "    fi",
    "  fi",
    "}",
    "",
    "run_intent_guard() {",
    '  if command -v intent-guard-check >/dev/null 2>&1; then',
    '    intent-guard-check --project . --staged',
    '  elif command -v intent-guard >/dev/null 2>&1; then',
    '    intent-guard check --project . --staged',
    '  elif command -v npx >/dev/null 2>&1; then',
    '    npx --no-install intent-guard check --project . --staged',
    "  else",
    '    echo "pre-commit: intent-guard not found on PATH; refusing the commit. Install @vaultcompass/intent-guard, or bypass once with git commit --no-verify." >&2',
    `    return ${HOOK_MISSING_BINARY_EXIT}`,
    "  fi",
    "}",
    "",
    "run_intent_guard",
    'record "intent-guard" "$?"',
    "",
  ];

  if (withVaultGuard) {
    lines.push(
      "run_vault_guard() {",
      '  if command -v vault-guard >/dev/null 2>&1; then',
      '    vault-guard scan --staged',
      '  elif command -v npx >/dev/null 2>&1; then',
      '    npx --no-install vault-guard scan --staged',
      "  else",
      '    echo "pre-commit: vault-guard not found on PATH; refusing the commit. Install vault-guard, or bypass once with git commit --no-verify." >&2',
      `    return ${HOOK_MISSING_BINARY_EXIT}`,
      "  fi",
      "}",
      "",
      "run_vault_guard",
      'record "vault-guard" "$?"',
      "",
    );
  }

  lines.push('exit "$status"', "");
  return lines.join("\n");
}

/**
 * Install the Intent Guard pre-commit hook into the repository at projectRoot.
 * Refuses, unless force is set, to replace a hook it did not write (no
 * managed header line) or a managed hook edited after install (not byte-equal
 * to a rendered script). A refusal changes nothing.
 *
 * When a machine-wide `core.hooksPath` points outside this repo, defaults to
 * setting local `core.hooksPath=.git/hooks` so install does not overwrite a
 * shared hooks directory (common with global vault-guard installs). That is
 * done only after the ownership check passes, and the result names the
 * directory whose hooks stop running here (previousHooksPath).
 */
export function installPreCommitHook(
  projectRoot: string,
  options: InstallHookOptions = {},
): InstallHookResult {
  const withVaultGuard = options.withVaultGuard ?? false;
  const preferLocal = options.preferLocalGitHooks ?? true;
  const gitDir = join(projectRoot, ".git");

  if (!existsSync(gitDir)) {
    return {
      installed: false,
      path: join(gitDir, "hooks", "pre-commit"),
      reason: "not_a_git_repo",
      withVaultGuard,
    };
  }

  let localizedHooksPath = false;
  const insideWorkTree = spawnSync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: projectRoot, env: gitSpawnEnv(), encoding: "utf8" },
  );
  const usableGit = insideWorkTree.status === 0;

  let resolved: ResolvedHooksDir = usableGit
    ? resolveGitHooksDir(projectRoot)
    : {
        hooksDir: join(gitDir, "hooks"),
        displayHookPath: ".git/hooks/pre-commit",
        hooksPathConfig: null,
      };

  // Decided here, acted on only after the ownership check below: a refused
  // install changes nothing, core.hooksPath included.
  const localize =
    usableGit &&
    preferLocal &&
    resolved.hooksPathConfig !== null &&
    !isPathInside(projectRoot, resolved.hooksDir);
  const previousHooksDir = resolved.hooksDir;
  if (localize) {
    resolved = {
      hooksDir: join(gitDir, "hooks"),
      displayHookPath: ".git/hooks/pre-commit",
      hooksPathConfig: ".git/hooks",
    };
  }

  const hookPath = join(resolved.hooksDir, "pre-commit");

  let discardedEdits = false;
  // The bytes and mode of the hook being replaced, kept so a failure after
  // the write can put it back.
  let previous: { bytes: Buffer; mode: number } | null = null;
  if (existsSync(hookPath)) {
    const bytes = readFileSync(hookPath);
    previous = { bytes, mode: statSync(hookPath).mode & 0o7777 };
    const existing = bytes.toString("utf8");
    if (hasManagedHeaderWithOtherLineEndings(existing)) {
      if (!options.force) {
        return {
          installed: false,
          path: hookPath,
          reason: "managed_hook_line_endings",
          withVaultGuard,
        };
      }
      discardedEdits = true;
    } else if (!isManagedHook(existing)) {
      if (!options.force) {
        return {
          installed: false,
          path: hookPath,
          reason: "existing_hook_not_managed",
          withVaultGuard,
        };
      }
    } else if (!isUneditedManagedHook(existing)) {
      if (!options.force) {
        return {
          installed: false,
          path: hookPath,
          reason: "managed_hook_edited",
          withVaultGuard,
        };
      }
      discardedEdits = true;
    }
  }

  // The hook is written first and core.hooksPath changed last, so a write
  // that fails (a read-only hooks directory or hook file) is a refusal that
  // has changed nothing, and core.hooksPath never points at a directory
  // with no hook in it.
  try {
    mkdirSync(resolved.hooksDir, { recursive: true });
    writeFileSync(hookPath, renderPreCommitHook(withVaultGuard), "utf8");
    chmodSync(hookPath, 0o755);
  } catch {
    // A failed chmod after a successful write leaves the new bytes in
    // place, so the old ones go back; a failed open wrote nothing.
    restoreHook(hookPath, previous);
    return {
      installed: false,
      path: hookPath,
      reason: "hook_write_failed",
      withVaultGuard,
    };
  }

  if (localize) {
    const localized = spawnSync(
      "git",
      ["config", "core.hooksPath", ".git/hooks"],
      { cwd: projectRoot, env: gitSpawnEnv(), encoding: "utf8" },
    );
    if (localized.status !== 0) {
      // Git still reads the shared directory, so the hook just written here
      // would never run: put back what was there before.
      restoreHook(hookPath, previous);
      return {
        installed: false,
        path: join(previousHooksDir, "pre-commit"),
        reason: "hooks_path_localize_failed",
        withVaultGuard,
      };
    }
    localizedHooksPath = true;
  }

  return {
    installed: true,
    path: hookPath,
    withVaultGuard,
    localizedHooksPath,
    ...(localizedHooksPath ? { previousHooksPath: previousHooksDir } : {}),
    ...(discardedEdits ? { discardedEdits } : {}),
  };
}
