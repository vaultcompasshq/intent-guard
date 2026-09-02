import { describe, expect, it } from "vitest";
import { summarizeVaultGuardRun } from "../src/vault-guard-scan.js";

// Shape taken from a real `vault-guard scan --format json` run (vault-guard
// 1.4.1). `summary.secrets` counts every match regardless of severity;
// `run.blocking_matches` counts only matches at or above the active `fail_on`
// threshold, which is the field vault-guard tells integrators to gate on.
function vaultGuardJson(options: {
  secrets: number;
  files: number;
  blockingMatches: number;
  failOn?: string;
}): string {
  return JSON.stringify({
    version: "1",
    scannedAt: "2026-09-02T18:38:12.338Z",
    summary: { files: options.files, secrets: options.secrets },
    run: {
      duration_ms: 8,
      files_scanned: 4,
      bytes_scanned: 11626,
      patterns_active: 59,
      diagnostics_count: 0,
      fail_on: options.failOn ?? "medium",
      blocking_matches: options.blockingMatches,
    },
    results: [],
  });
}

describe("summarizeVaultGuardRun", () => {
  it("does not block when matches exist but none clear the threshold", () => {
    const summary = summarizeVaultGuardRun(
      vaultGuardJson({ secrets: 3, files: 2, blockingMatches: 0 }),
      0,
      "1.4.1",
    );

    expect(summary.available).toBe(true);
    expect(summary.blockingMatches).toBe(0);
    expect(summary.blocked).toBe(false);
    // secrets stays visible, but only as information.
    expect(summary.secrets).toBe(3);
    expect(summary.files).toBe(2);
    expect(summary.failOn).toBe("medium");
  });

  it("blocks when vault-guard reports blocking matches", () => {
    const summary = summarizeVaultGuardRun(
      vaultGuardJson({ secrets: 3, files: 2, blockingMatches: 1 }),
      1,
      "1.4.1",
    );

    expect(summary.blockingMatches).toBe(1);
    expect(summary.blocked).toBe(true);
  });

  it("ignores summary.secrets entirely when deciding to block", () => {
    const noSecretsButBlocking = summarizeVaultGuardRun(
      vaultGuardJson({ secrets: 0, files: 0, blockingMatches: 2 }),
      1,
      "1.4.1",
    );
    expect(noSecretsButBlocking.blocked).toBe(true);

    const manySecretsNoneBlocking = summarizeVaultGuardRun(
      vaultGuardJson({ secrets: 99, files: 40, blockingMatches: 0 }),
      0,
      "1.4.1",
    );
    expect(manySecretsNoneBlocking.blocked).toBe(false);
  });

  it("falls back to the exit code when the run block is unreadable", () => {
    const unparseable = summarizeVaultGuardRun("not json at all", 1, "1.4.1");
    expect(unparseable.blockingMatches).toBe(0);
    expect(unparseable.blocked).toBe(true);

    const missingRun = summarizeVaultGuardRun(
      JSON.stringify({ summary: { secrets: 5, files: 1 } }),
      0,
      "1.4.1",
    );
    expect(missingRun.secrets).toBe(5);
    expect(missingRun.blocked).toBe(false);
  });
});
