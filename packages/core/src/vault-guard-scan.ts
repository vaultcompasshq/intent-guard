import { spawnSync } from "node:child_process";

export interface VaultGuardScanSummary {
  available: boolean;
  skipped?: string;
  /**
   * Informational only. Counts every match vault-guard found, ignoring the
   * active severity threshold. Never gate a build on this number: vault-guard
   * itself does not.
   */
  secrets: number;
  /**
   * Authoritative. Matches at or above vault-guard's active `fail_on`
   * threshold, i.e. the findings vault-guard would fail its own run on.
   */
  blockingMatches: number;
  /** True when vault-guard would fail this scan. Derived from blockingMatches. */
  blocked: boolean;
  files: number;
  exitCode: number;
  /** The threshold vault-guard applied, when it reported one. */
  failOn?: string;
  version?: string;
}

interface VaultGuardJson {
  summary?: { secrets?: number; files?: number };
  run?: { blocking_matches?: number; fail_on?: string };
}

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function parseJson(stdout: string): VaultGuardJson | null {
  try {
    return JSON.parse(stdout) as VaultGuardJson;
  } catch {
    return null;
  }
}

/**
 * Turn one vault-guard JSON run into a summary.
 *
 * The blocking verdict comes from `run.blocking_matches`, which already honours
 * vault-guard's `fail_on` threshold. `summary.secrets` counts every match at
 * any severity and is carried through for display only; reading it as a gate
 * makes Conductor block on findings vault-guard would let through, and it
 * diverges further every time the threshold moves.
 *
 * When the run block is missing or the output is not JSON we cannot read the
 * threshold-aware count, so the verdict falls back to vault-guard's own exit
 * code rather than to the raw match count.
 */
export function summarizeVaultGuardRun(
  stdout: string,
  exitCode: number,
  version?: string,
): VaultGuardScanSummary {
  const parsed = parseJson(stdout);
  const blockingMatches = parsed?.run?.blocking_matches;
  const known = typeof blockingMatches === "number";

  return {
    available: true,
    version,
    secrets: parsed?.summary?.secrets ?? 0,
    files: parsed?.summary?.files ?? 0,
    blockingMatches: known ? blockingMatches : 0,
    blocked: known ? blockingMatches > 0 : exitCode !== 0,
    failOn: parsed?.run?.fail_on,
    exitCode,
  };
}

/**
 * Optional vault-guard staged scan for handoff reports. Returns a skipped summary
 * when vault-guard is not installed; never throws.
 */
export function scanVaultGuardStaged(projectRoot: string): VaultGuardScanSummary {
  const version = commandVersion("vault-guard");
  if (!version) {
    return {
      available: false,
      skipped: "vault-guard not found on PATH",
      secrets: 0,
      files: 0,
      blockingMatches: 0,
      blocked: false,
      exitCode: 0,
    };
  }

  const result = spawnSync("vault-guard", ["scan", "--staged", "--format", "json"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return summarizeVaultGuardRun(
    result.stdout ?? "",
    typeof result.status === "number" ? result.status : 1,
    version,
  );
}
