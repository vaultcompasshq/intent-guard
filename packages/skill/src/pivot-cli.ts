#!/usr/bin/env node
import {
  addPivot,
  readContract,
  writeContract,
  writeIndex,
} from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard pivot --change <text> [flags]

Record an intentional scope change against the active Intent Contract.

Flags:
  --change <text>              What changed (required)
  --reason <text>              Why it changed
  --add-scope <text>           Add an in-scope item (repeatable)
  --remove-scope <text>        Remove an in-scope item (repeatable)
  --add-out-of-scope <text>    Add an out-of-scope item (repeatable)
  --acknowledge                Mark the pivot acknowledged by the user
  --project <root>             Project root (default: .)
  --help, -h                   Show this help
  --version, -v                Print the version`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let change = "";
  let reason = "";
  let acknowledge = false;
  let help = false;
  let version = false;
  const addScope: string[] = [];
  const removeScope: string[] = [];
  const addOutOfScope: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--change" && argv[i + 1]) change = argv[++i];
    else if (arg === "--reason" && argv[i + 1]) reason = argv[++i];
    else if (arg === "--add-scope" && argv[i + 1]) addScope.push(argv[++i]);
    else if (arg === "--remove-scope" && argv[i + 1]) removeScope.push(argv[++i]);
    else if (arg === "--add-out-of-scope" && argv[i + 1]) addOutOfScope.push(argv[++i]);
    else if (arg === "--acknowledge") acknowledge = true;
    else if (isHelpFlag(arg)) help = true;
    else if (isVersionFlag(arg)) version = true;
  }

  return {
    projectRoot,
    change,
    reason,
    acknowledge,
    addScope,
    removeScope,
    addOutOfScope,
    help,
    version,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

if (!args.change) {
  console.error(
    "Usage: intent-guard-pivot --change <text> [--reason <text>] [--add-scope <text>] [--remove-scope <text>] [--add-out-of-scope <text>] [--acknowledge] [--project <root>]",
  );
  process.exit(1);
}

const contract = readContract(args.projectRoot);
if (!contract) {
  console.error("No .intent-guard/intent-contract.yaml found. Run intent-guard-extract first.");
  process.exit(1);
}

const updated = addPivot(contract, {
  change: args.change,
  reason: args.reason || undefined,
  acknowledged: args.acknowledge,
  in_scope_added: args.addScope,
  in_scope_removed: args.removeScope,
  out_of_scope_added: args.addOutOfScope,
});
const writtenPath = writeContract(args.projectRoot, updated);
const indexPath = writeIndex(args.projectRoot);
const entry = updated.pivot_log[updated.pivot_log.length - 1];

console.log(
  JSON.stringify({
    written_path: writtenPath,
    index_path: indexPath,
    pivot: entry,
    pending: entry.acknowledged_by === "pending",
  }),
);
