#!/usr/bin/env node
import { installPreCommitHook } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, missingValue, printUsage, printVersion } from "./usage.js";

const REASONS: Record<string, string> = {
  not_a_git_repo: "No .git directory found. Run this inside a git repository.",
  existing_hook_not_managed:
    "A pre-commit hook already exists and was not created by Intent Guard. Re-run with --force to overwrite it.",
  hooks_path_localize_failed:
    "Could not set local core.hooksPath=.git/hooks (machine-wide hooksPath is outside this repo). Set it manually, then re-run.",
};

const USAGE = `Usage: intent-guard hook install [flags]

Install a self-contained Git pre-commit hook that runs the Intent Guard gate on
staged changes. The hook depends only on the installed CLIs, not on the
Intent Guard source repo. It is fail-closed: a gate whose binary is missing
refuses the commit rather than skipping.

Flags:
  --project <dir>      Project root (default: .)
  --with-vault-guard   Also run vault-guard secret scanning in the hook
  --force              Overwrite an existing hook Intent Guard did not write
  --json               Emit JSON (default)
  --human              Human-readable output
  --help, -h           Show this help
  --version, -v        Print the version`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

// The one flag here that takes a value. Reaching the arm below with it means
// the value was missing or empty, which is a different mistake from a flag
// that does not exist and gets a different sentence.
const VALUE_FLAGS = new Set(["--project"]);

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let withVaultGuard = false;
  let force = false;
  let human = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--with-vault-guard") withVaultGuard = true;
    else if (arg === "--force") force = true;
    else if (arg === "--human") human = true;
    else if (arg === "--json") human = false;
    else if (isHelpFlag(arg)) help = true;
    else if (isVersionFlag(arg)) version = true;
    // A known flag that arrived without its value, before the arm below.
    else if (VALUE_FLAGS.has(arg)) badUsage(missingValue(arg));
    else {
      // A DROPPED FLAG HERE REMOVES A SECURITY CONTROL, which is why this arm
      // matters more than the same arm on the other flags-only commands.
      //
      // --with-vault-guard pairs the generated pre-commit hook with a
      // vault-guard secret scan. Mistyped, it used to be dropped without a
      // word and the install still SUCCEEDED, printing installed: true. What
      // landed was a hook with no secrets scanning in it, while the user had
      // every reason to believe they had just installed secrets scanning --
      // so the next commit full of credentials sails through a gate they think
      // is armed. Refusing costs one retyped flag; the silent version costs a
      // leaked secret.
      badUsage(`unknown option '${arg}'`);
    }
  }

  return { projectRoot, withVaultGuard, force, human, help, version };
}

// Accept an optional leading "install" subcommand for a natural CLI feel.
const argv = process.argv.slice(2);
const rest = argv[0] === "install" ? argv.slice(1) : argv;
const args = parseArgs(rest);
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const result = installPreCommitHook(args.projectRoot, {
  withVaultGuard: args.withVaultGuard,
  force: args.force,
});

if (args.human) {
  if (result.installed) {
    console.log(`Installed Intent Guard pre-commit hook at ${result.path}`);
    if (result.localizedHooksPath) {
      console.log(
        "Set local core.hooksPath=.git/hooks so a machine-wide hooks directory is not overwritten.",
      );
    }
    if (result.withVaultGuard) console.log("Paired with vault-guard secret scanning.");
    console.log("Bypass a single commit with: git commit --no-verify");
  } else {
    console.error(REASONS[result.reason ?? ""] ?? `Could not install hook: ${result.reason}`);
  }
} else {
  console.log(JSON.stringify(result));
}

process.exit(result.installed ? 0 : 1);
