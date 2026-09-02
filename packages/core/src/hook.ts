import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONDUCTOR_HOOK_MARKER = "conductor-managed-pre-commit";

export interface InstallHookOptions {
  /** Also run vault-guard secret scanning in the generated hook. */
  withVaultGuard?: boolean;
  /** Overwrite an existing pre-commit hook that Conductor did not write. */
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
 * CLIs (conductor-check, optionally vault-guard) being resolvable on PATH or via
 * npx, never on the Conductor repo's integrations/ directory — which does not
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
    "# Installed by: conductor hook install",
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
    "run_conductor() {",
    '  if command -v conductor-check >/dev/null 2>&1; then',
    '    conductor-check --project . --staged',
    '  elif command -v conductor >/dev/null 2>&1; then',
    '    conductor check --project . --staged',
    '  elif command -v npx >/dev/null 2>&1; then',
    '    npx --no-install conductor check --project . --staged',
    "  else",
    '    echo "pre-commit: conductor not found on PATH; refusing the commit. Install @vaultcompass/conductor-cli, or bypass once with git commit --no-verify." >&2',
    `    return ${HOOK_MISSING_BINARY_EXIT}`,
    "  fi",
    "}",
    "",
    "run_conductor",
    'record "conductor" "$?"',
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
 * Install the Conductor pre-commit hook into the repository at projectRoot.
 * Refuses to clobber a foreign (non-Conductor) hook unless force is set.
 *
 * When a machine-wide `core.hooksPath` points outside this repo, defaults to
 * setting local `core.hooksPath=.git/hooks` so install does not overwrite a
 * shared hooks directory (common with global vault-guard installs).
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
    { cwd: projectRoot, encoding: "utf8" },
  );
  const usableGit = insideWorkTree.status === 0;

  let resolved: ResolvedHooksDir = usableGit
    ? resolveGitHooksDir(projectRoot)
    : {
        hooksDir: join(gitDir, "hooks"),
        displayHookPath: ".git/hooks/pre-commit",
        hooksPathConfig: null,
      };

  if (
    usableGit &&
    preferLocal &&
    resolved.hooksPathConfig &&
    !isPathInside(projectRoot, resolved.hooksDir)
  ) {
    const localize = spawnSync(
      "git",
      ["config", "core.hooksPath", ".git/hooks"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    if (localize.status !== 0) {
      return {
        installed: false,
        path: join(resolved.hooksDir, "pre-commit"),
        reason: "hooks_path_localize_failed",
        withVaultGuard,
      };
    }
    localizedHooksPath = true;
    resolved = {
      hooksDir: join(gitDir, "hooks"),
      displayHookPath: ".git/hooks/pre-commit",
      hooksPathConfig: ".git/hooks",
    };
  }

  const hookPath = join(resolved.hooksDir, "pre-commit");

  if (existsSync(hookPath) && !options.force) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(CONDUCTOR_HOOK_MARKER)) {
      return {
        installed: false,
        path: hookPath,
        reason: "existing_hook_not_managed",
        withVaultGuard,
        localizedHooksPath,
      };
    }
  }

  mkdirSync(resolved.hooksDir, { recursive: true });
  writeFileSync(hookPath, renderPreCommitHook(withVaultGuard), "utf8");
  chmodSync(hookPath, 0o755);

  return {
    installed: true,
    path: hookPath,
    withVaultGuard,
    localizedHooksPath,
  };
}
