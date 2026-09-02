/**
 * Shared help handling for the Conductor subcommand CLIs.
 *
 * Two rules, both learned from the 2026-09-02 run against the published 1.1.0
 * artifacts, where `intent-guard check --help` and `intent-guard report --help` ran
 * the gate against the current directory instead of printing anything:
 *
 * 1. Help has no side effects. It prints and exits 0, before the command does
 *    any work, reads any contract, or writes any file.
 * 2. Help is a flag, not a value. Detection belongs inside a command's own
 *    argument loop, which is the only place that knows whether the token it is
 *    looking at is a flag or the value of the flag before it. Scanning argv
 *    from the outside reads `--message --help` as a help request when the user
 *    asked to score the literal text "--help".
 */

/** True when this token, in flag position, is a help request. */
export function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
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
