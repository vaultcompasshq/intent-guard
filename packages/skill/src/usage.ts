/**
 * Shared help and version handling for the Intent Guard subcommand CLIs.
 *
 * Two rules, both learned from the 2026-09-02 run against the published 1.1.0
 * artifacts, where `intent-guard check --help` and `intent-guard report --help` ran
 * the gate against the current directory instead of printing anything. The
 * same bug class showed up again for `--version`: `intent-guard-check --version`
 * ran the gate too, because none of the per-command bins parsed it.
 *
 * 1. Help and version have no side effects. Each prints and exits 0, before
 *    the command does any work, reads any contract, or writes any file.
 * 2. Help and version are flags, not values. Detection belongs inside a
 *    command's own argument loop, which is the only place that knows whether
 *    the token it is looking at is a flag or the value of the flag before it.
 *    Scanning argv from the outside reads `--message --help` as a help
 *    request when the user asked to score the literal text "--help", and the
 *    same is true of `--message --version`.
 */

import { readFileSync } from "node:fs";
import { StateDirError } from "@vaultcompass/intent-guard-core";

/**
 * A refused state directory is a designed outcome with a message written for a
 * user: both directories present, or a file or symlink where one belongs.
 * Without this every command except doctor answered it with a raw Node stack
 * trace, which reads as a crash in the tool rather than a state the user has
 * to fix. Installed on import because every one of the sixteen bins imports
 * this module, so there is no entry point left to forget it.
 *
 * Anything else keeps Node's own behaviour: the stack, then exit 1.
 */
process.on("uncaughtException", (error) => {
  if (error instanceof StateDirError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});

/** True when this token, in flag position, is a help request. */
export function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

/** True when this token, in flag position, is a version request. */
export function isVersionFlag(arg: string): boolean {
  return arg === "--version" || arg === "-v";
}

/**
 * Help goes to stdout and exits 0. A user who asked for help got what they
 * asked for, so this is not an error: piping help into a pager or a file has
 * to work, and a non-zero exit here fails scripts that run `cmd --help` to
 * check that a command exists.
 */
export function printUsage(usage: string): never {
  console.log(usage);
  process.exit(0);
}

/**
 * Reads the skill package's own version from its package.json, resolved
 * relative to this module so it works from the built dist file. One helper,
 * shared by every skill bin, so the sixteen intent-guard-* commands can never
 * drift from the package they actually ship in.
 */
export function readPackageVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * Version goes to stdout and exits 0, for the same reasons as printUsage:
 * no side effects, and a zero exit so scripts checking `cmd --version` work.
 */
export function printVersion(): never {
  console.log(readPackageVersion());
  process.exit(0);
}
