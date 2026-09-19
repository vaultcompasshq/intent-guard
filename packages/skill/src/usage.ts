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
import { ConfigError, StateDirError, TrustBaseError } from "@vaultcompass/intent-guard-core";

/**
 * A refused state directory is a designed outcome with a message written for a
 * user: both directories present, or a file or symlink where one belongs.
 * Without this every command except doctor answered it with a raw Node stack
 * trace, which reads as a crash in the tool rather than a state the user has
 * to fix. Installed on import because every one of the sixteen bins imports
 * this module, so there is no entry point left to forget it.
 *
 * Two more designed outcomes join it, and both exit 2 rather than 1. A config
 * file the schema refuses and a base ref that will not resolve are both
 * COULD NOT RUN: nothing was judged, so reporting either as exit 1 would say
 * the gate blocked the change, and a caller that only distinguishes zero from
 * non-zero would read "your config is broken" as "your code is wrong". Exit 2
 * is the code this tool already uses for a base ref it could not resolve, and
 * the umbrella already treats anything above 1 as could-not-run.
 *
 * Anything else keeps Node's own behaviour: the stack, then exit 1.
 */
process.on("uncaughtException", (error) => {
  if (error instanceof ConfigError || error instanceof TrustBaseError) {
    console.error(error.message);
    process.exit(2);
  }
  if (error instanceof StateDirError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});

/**
 * The reason text for a known flag that arrived without its value.
 *
 * Every SCALAR value-taking arm in these parsers is shaped
 * `arg === "--reason" && argv[i + 1]`, so a correctly spelled flag with
 * nothing after it, or with an empty string after it, falls out of its own arm
 * and reaches the trailing unknown-option arm. That told the user
 * `unknown option '--reason'` about a flag printed in the usage text directly
 * below, and sent them hunting a spelling mistake that was not there. Each
 * parser names its own value-taking flags; the sentence lives here so the
 * answer is the same on all sixteen commands.
 *
 * The list-shaped flags use listValueAt below instead, because for them an
 * empty string is a value and not an omission.
 */
export function missingValue(arg: string): string {
  return `option '${arg}' requires a value`;
}

/**
 * The value of a LIST-shaped flag (`--paths`, `--signals`) at `argv[i]`, or
 * undefined when that flag has no value of its own.
 *
 * An empty string is a VALUE here, and it means the empty list. That is the
 * difference between a list and a scalar: there is no such thing as an empty
 * project root, but "nothing changed" is a perfectly good path list, and it is
 * the one a caller sends most often. A pull-request runner builds the list
 * from a diff against the base ref and passes `--paths ""` when the diff comes
 * back empty, so that the empty set is STATED rather than left for the gate to
 * infer from whatever else it can see. 1.5.1 tested the next token for
 * truthiness, so that call fell into the missing-value arm and was answered
 * with the usage screen and exit 1 instead of a report.
 *
 * Missing is either of two things. Nothing after the flag at all, or another
 * flag after it: `--paths --json` used to be accepted, and swallowed `--json`
 * as the path list, so the gate judged a path literally named "--json" and
 * printed human output to a caller waiting for JSON. A leading dash is
 * therefore not a value, which costs nothing real because a changed path or a
 * free-text signal does not begin with one.
 */
export function listValueAt(argv: string[], i: number): string | undefined {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("-")) return undefined;
  return next;
}

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
