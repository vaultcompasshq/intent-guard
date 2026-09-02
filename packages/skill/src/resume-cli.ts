#!/usr/bin/env node
import { renderResume } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, printUsage } from "./usage.js";

const USAGE = `Usage: intent-guard resume [flags]

Emit a Session Brief plus recent history for the active Intent Contract.

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

const resumeMarkdown = renderResume(args.projectRoot);

if (!resumeMarkdown) {
  console.error("No .conductor/intent-contract.yaml found. Run intent-guard-extract first.");
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify({ resume_markdown: resumeMarkdown }));
} else {
  console.log(resumeMarkdown);
}
