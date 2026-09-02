#!/usr/bin/env node
import { renderIndex, writeIndex } from "@vaultcompass/conductor-core";
import { isHelpFlag, printUsage } from "./usage.js";

const USAGE = `Usage: conductor index [flags]

Render .conductor/index.md, or regenerate it on disk with --write.

Flags:
  --project <root>   Project root (default: .)
  --write            Write the index instead of printing it
  --json             Machine-readable output
  --help, -h         Show this help`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let write = false;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--write") write = true;
    else if (arg === "--json") json = true;
    else if (isHelpFlag(arg)) help = true;
  }

  return { projectRoot, write, json, help };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);

const indexMarkdown = renderIndex(args.projectRoot);
const writtenPath = args.write ? writeIndex(args.projectRoot) : null;

if (args.json) {
  console.log(
    JSON.stringify({
      written_path: writtenPath,
      index_markdown: indexMarkdown,
    }),
  );
} else if (writtenPath) {
  console.log(`✓ Wrote ${writtenPath}`);
} else {
  console.log(indexMarkdown);
}
