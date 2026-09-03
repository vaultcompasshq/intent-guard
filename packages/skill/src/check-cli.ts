#!/usr/bin/env node
import {
  appendDriftEvent,
  checkGate,
  crossSessionDrift,
  formatDriftMessage,
  readArchivedContract,
  readContract,
} from "@vaultcompass/intent-guard-core";
import { collectChangedPaths } from "./changed-paths.js";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard check [flags]

Run the enforcement gate against changed paths. Exits non-zero when the gate
blocks the change.

Flags:
  --project <root>            Project root (default: .)
  --staged                    Collect staged paths from git
  --base <ref>                Collect paths changed since the merge base with <ref>
  --paths a,b                 Explicit changed paths
  --signals "x,y"             Free-text descriptions of what changed
  --message "<text>"          Latest user message
  --previous-contract <id>    Include prior-contract drift context
  --no-require-frozen         Allow a missing or unfrozen contract
  --log                       Append the result to the drift log
  --json                      Machine-readable output
  --help, -h                  Show this help
  --version, -v               Print the version

--base is additive with --paths and --staged. It fails closed: an unknown ref
or a missing merge base exits 2 rather than gating on an empty path set.`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
function badUsage(): never {
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  const paths: string[] = [];
  const signals: string[] = [];
  let userMessage = "";
  let staged = false;
  let base = "";
  let requireFrozen = true;
  let json = false;
  let log = false;
  let previousContract = "";
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
    } else if (arg === "--no-require-frozen") {
      requireFrozen = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--log") {
      log = true;
    } else if (arg === "--previous-contract" && argv[i + 1]) {
      previousContract = argv[++i];
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    }
  }

  return {
    projectRoot,
    paths,
    signals,
    userMessage,
    staged,
    base,
    requireFrozen,
    json,
    log,
    previousContract,
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

const result = checkGate(args.projectRoot, {
  requireFrozen: args.requireFrozen,
  signals: {
    changedPaths,
    signals: args.signals,
    userMessage: args.userMessage || undefined,
  },
});

const crossSession =
  args.previousContract
    ? (() => {
        const previous = readArchivedContract(
          args.projectRoot,
          args.previousContract,
        );
        const current = readContract(args.projectRoot);
        if (!previous || !current) return null;
        return crossSessionDrift(previous, current, {
          changedPaths,
          signals: args.signals,
          userMessage: args.userMessage || undefined,
        });
      })()
    : null;

if (args.log && result.drift) {
  appendDriftEvent(args.projectRoot, {
    contract_id: "gate-check",
    overall: result.drift.overall,
    action: result.drift.action,
    findings: result.drift.findings,
    changed_paths: changedPaths,
    user_message: args.userMessage || undefined,
  });
}

if (args.json) {
  console.log(JSON.stringify({ ...result, crossSessionDrift: crossSession }));
} else if (result.status === "blocked") {
  console.error("✖ Intent Guard gate: BLOCKED");
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  if (result.drift) {
    console.error("");
    console.error(formatDriftMessage(result.drift));
  }
} else {
  console.log("✓ Intent Guard gate: ok");
  if (result.drift && result.drift.action !== "proceed") {
    console.log(`  drift: ${result.drift.action} (${result.drift.overall}/100)`);
  }
  if (crossSession && crossSession.previous.action !== "proceed") {
    console.log(
      `  prior-contract drift: ${crossSession.previous.action} (${crossSession.previous.overall}/100 vs ${crossSession.previous_contract_id})`,
    );
  }
}

process.exit(result.exitCode);
