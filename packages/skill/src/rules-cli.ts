#!/usr/bin/env node
import {
  auditRules,
  renderRulesAuditMarkdown,
} from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard rules audit [flags]

Inspect project rule files (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules,
.continue/rules, .kiro/steering) and surface maintainability problems.

Flags:
  --project <root>   Project root (default: .)
  --json             Machine-readable output
  --help, -h         Show this help
  --version, -v      Print the version`;

function badUsage(): never {
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;

  // A bare leading help or version flag is a request, checked before the
  // subcommand so `intent-guard rules --help` (or --version) is honored
  // rather than complaining that "audit" is missing. Everything after that
  // is decided by the loop below, which is the only place that knows whether
  // a token is a flag or the value of the flag before it: `--project --help`
  // names a directory called "--help", and scanning argv would read it as a
  // help request.
  if (command !== undefined && isHelpFlag(command)) printUsage(USAGE);
  if (command !== undefined && isVersionFlag(command)) printVersion();
  if (command !== "audit") badUsage();

  let projectRoot = ".";
  let json = false;
  let help = false;
  let version = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--project" && rest[i + 1]) {
      projectRoot = rest[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    }
  }

  return { projectRoot, json, help, version };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const result = auditRules(args.projectRoot);

if (args.json) {
  console.log(JSON.stringify(result));
} else {
  console.log(renderRulesAuditMarkdown(result));
}

process.exit(0);
