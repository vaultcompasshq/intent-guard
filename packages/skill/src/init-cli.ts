#!/usr/bin/env node
import { initConductor } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard init [flags]

Create a .conductor project skeleton: config, contracts directory, and the
generated index.

Flags:
  --project <root>   Project root (default: .)
  --json             Machine-readable output (default)
  --human            Human-readable output
  --help, -h         Show this help
  --version, -v      Print the version`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let json = true;
  let human = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--json") {
      json = true;
      human = false;
    } else if (arg === "--human") {
      human = true;
      json = false;
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    }
  }

  return { projectRoot, json, human, help, version };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const result = initConductor(args.projectRoot);

if (args.human) {
  console.log(`Intent Guard initialized in ${result.conductor_dir}`);
  if (result.created.length > 0) {
    console.log(`Created: ${result.created.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped (already present): ${result.skipped.join(", ")}`);
  }
  console.log("");
  console.log("Next steps:");
  for (const step of result.next_steps) {
    console.log(`  ${step}`);
  }
} else {
  console.log(JSON.stringify(result));
}
