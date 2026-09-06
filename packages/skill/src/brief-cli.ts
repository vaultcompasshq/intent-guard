#!/usr/bin/env node
import { buildBrief, readContract, renderBriefMarkdown } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard brief [flags]

Emit a compact Session Brief for the active Intent Contract.

Flags:
  --project <root>   Project root (default: .)
  --json             Machine-readable output
  --help, -h         Show this help
  --version, -v      Print the version`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let json = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--json") json = true;
    else if (isHelpFlag(arg)) help = true;
    else if (isVersionFlag(arg)) version = true;
  }
  return { projectRoot, json, help, version };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const contract = readContract(args.projectRoot);
if (!contract) {
  console.error("No frozen .intent-guard/intent-contract.yaml found.");
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(buildBrief(contract)));
} else {
  console.log(renderBriefMarkdown(contract));
}
