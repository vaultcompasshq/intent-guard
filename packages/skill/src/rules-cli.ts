#!/usr/bin/env node
import {
  auditRules,
  renderRulesAuditMarkdown,
} from "@vaultcompass/conductor-core";
import { isHelpFlag, printUsage } from "./usage.js";

const USAGE = `Usage: conductor rules audit [flags]

Inspect project rule files (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules,
.continue/rules, .kiro/steering) and surface maintainability problems.

Flags:
  --project <root>   Project root (default: .)
  --json             Machine-readable output
  --help, -h         Show this help`;

function badUsage(): never {
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  // Help is checked before the subcommand, so `conductor rules --help` prints
  // help rather than complaining that "audit" is missing.
  if (argv.some(isHelpFlag)) printUsage(USAGE);
  if (command !== "audit") badUsage();

  let projectRoot = ".";
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--project" && rest[i + 1]) {
      projectRoot = rest[++i];
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { projectRoot, json };
}

const args = parseArgs(process.argv.slice(2));
const result = auditRules(args.projectRoot);

if (args.json) {
  console.log(JSON.stringify(result));
} else {
  console.log(renderRulesAuditMarkdown(result));
}

process.exit(0);
