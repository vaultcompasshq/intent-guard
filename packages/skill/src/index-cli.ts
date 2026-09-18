#!/usr/bin/env node
import { renderIndex, writeIndex } from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard index [flags]

Render .intent-guard/index.md, or regenerate it on disk with --write.

Flags:
  --project <root>   Project root (default: .)
  --write            Write the index instead of printing it
  --json             Machine-readable output
  --help, -h         Show this help
  --version, -v      Print the version`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let write = false;
  let json = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === "--write") write = true;
    else if (arg === "--json") json = true;
    else if (isHelpFlag(arg)) help = true;
    else if (isVersionFlag(arg)) version = true;
    // Anything unrecognised is refused rather than dropped. A mistyped --write
    // printed the index and wrote nothing, while exiting 0 as if it had.
    else badUsage(`unknown option '${arg}'`);
  }

  return { projectRoot, write, json, help, version };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

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
