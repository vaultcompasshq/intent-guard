#!/usr/bin/env node
import {
  buildConductorReport,
  renderConductorReportMarkdown,
} from "@vaultcompass/intent-guard-core";
import { collectChangedPaths } from "./changed-paths.js";
import { isHelpFlag, isVersionFlag, missingValue, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard report [flags]

Emit a PR/CI handoff report. Runs the same gate as intent-guard check and exits
with the gate result.

Flags:
  --project <root>            Project root (default: .)
  --staged                    Collect staged paths from git
  --base <ref>                Collect paths changed since the merge base with <ref>
  --trust-base <ref>          Pull-request mode: read every control input
                              (contract, config, contracts archive) from <ref>
  --paths a,b                 Explicit changed paths
  --signals "x,y"             Free-text descriptions of what changed
  --message "<text>"          Latest user message
  --previous-contract <id>    Include prior-contract drift context
  --no-require-frozen         Allow a missing or unfrozen contract
  --with-secrets              Append a vault-guard staged scan when installed
  --json                      Machine-readable output
  --help, -h                  Show this help
  --version, -v               Print the version

--base is additive with --paths and --staged. It fails closed: an unknown ref
or a missing merge base exits 2 rather than reporting on an empty path set.

--trust-base behaves exactly as it does for check, and the report gains a
Pull-request mode section naming the ref and every control input the head
proposes to change. The contract summarised is the base ref's, because that
is the one the gate judged against.`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
// The offending argument is named when there is one, because "here is the
// usage" leaves the reader to diff their command against it by eye.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

// The flags that take a value and are parsed by the `&& argv[i + 1]` arms
// below, which drop a flag whose value is missing or empty into the trailing
// arm. --base and --trust-base are deliberately absent: they check their own
// value and answer for themselves, and listing them here would change what
// they accept.
const VALUE_FLAGS = new Set([
  "--project",
  "--paths",
  "--signals",
  "--message",
  "--previous-contract",
]);

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  const paths: string[] = [];
  const signals: string[] = [];
  let userMessage = "";
  let staged = false;
  let base = "";
  let trustBase = "";
  let requireFrozen = true;
  let json = false;
  let previousContract = "";
  let withSecrets = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--paths" && argv[i + 1]) {
      paths.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--signals" && argv[i + 1]) {
      signals.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--message" && argv[i + 1]) {
      userMessage = argv[++i];
    } else if (arg === "--staged") {
      staged = true;
    } else if (arg === "--base") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) badUsage();
      base = next;
      i++;
    } else if (arg === "--trust-base") {
      // Same shape as --base: a missing value must not quietly mean "not in
      // pull-request mode", which is the permissive reading of a typo.
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) badUsage();
      trustBase = next;
      i++;
    } else if (arg === "--no-require-frozen") {
      requireFrozen = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--with-secrets") {
      withSecrets = true;
    } else if (arg === "--previous-contract" && argv[i + 1]) {
      previousContract = argv[++i];
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    } else if (VALUE_FLAGS.has(arg)) {
      // A known flag that arrived without its value, before the arm below.
      badUsage(missingValue(arg));
    } else {
      // Refused rather than dropped. See the longer note in check-cli.ts: a
      // silently ignored `--trust-bse` left this reading its control inputs
      // from the head instead of the base ref, and said nothing about it.
      badUsage(`unknown option '${arg}'`);
    }
  }

  return {
    projectRoot,
    paths,
    signals,
    userMessage,
    staged,
    base,
    trustBase,
    requireFrozen,
    json,
    previousContract,
    withSecrets,
    help,
    version,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const changedPaths = collectChangedPaths({
  projectRoot: args.projectRoot,
  paths: args.paths,
  staged: args.staged,
  base: args.base,
});

const report = buildConductorReport(args.projectRoot, {
  requireFrozen: args.requireFrozen,
  previousContract: args.previousContract || undefined,
  withSecrets: args.withSecrets,
  ...(args.trustBase ? { trustBase: args.trustBase } : {}),
  signals: {
    changedPaths,
    signals: args.signals,
    userMessage: args.userMessage || undefined,
  },
});

if (args.json) {
  console.log(JSON.stringify(report));
} else {
  console.log(renderConductorReportMarkdown(report));
}

process.exit(report.exitCode);
