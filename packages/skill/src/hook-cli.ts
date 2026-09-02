#!/usr/bin/env node
import { installPreCommitHook } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, printUsage } from "./usage.js";

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
  --help, -h           Show this help`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let withVaultGuard = false;
  let force = false;
  let human = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--with-vault-guard") withVaultGuard = true;
    else if (arg === "--force") force = true;
    else if (arg === "--human") human = true;
    else if (arg === "--json") human = false;
    else if (isHelpFlag(arg)) help = true;
  }

  return { projectRoot, withVaultGuard, force, human, help };
}

// Accept an optional leading "install" subcommand for a natural CLI feel.
const argv = process.argv.slice(2);
const rest = argv[0] === "install" ? argv.slice(1) : argv;
const args = parseArgs(rest);
if (args.help) printUsage(USAGE);

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
