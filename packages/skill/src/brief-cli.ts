#!/usr/bin/env node
import { buildBrief, readContract, renderBriefMarkdown } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, printUsage } from "./usage.js";

const USAGE = `Usage: intent-guard brief [flags]

Emit a compact Session Brief for the active Intent Contract.

Flags:
  --project <root>   Project root (default: .)
  --json             Machine-readable output
  --help, -h         Show this help`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--json") json = true;
    else if (isHelpFlag(arg)) help = true;
  }
  return { projectRoot, json, help };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);

const contract = readContract(args.projectRoot);
if (!contract) {
  console.error("No frozen .conductor/intent-contract.yaml found.");
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(buildBrief(contract)));
} else {
  console.log(renderBriefMarkdown(contract));
}
