#!/usr/bin/env node
import {
  runDoctor,
  type DoctorFinding,
  type DoctorFindingStatus,
} from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard doctor [flags]

Diagnose the local Intent Guard setup: contract, config, archive, generated index,
git hook, and the guard binaries this project references.

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
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
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

function marker(status: DoctorFindingStatus): string {
  if (status === "ok") return "ok";
  if (status === "info") return "info";
  if (status === "warn") return "warn";
  return "error";
}

function renderFinding(finding: DoctorFinding): string {
  const path = finding.path ? ` (${finding.path})` : "";
  const detail = finding.detail ? `\n    ${finding.detail}` : "";
  return `  [${marker(finding.status)}] ${finding.message}${path}${detail}`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const result = runDoctor(args.projectRoot);

if (args.json) {
  console.log(JSON.stringify(result));
} else {
  console.log(`Intent Guard doctor: ${result.status}`);
  console.log(
    `Summary: ${result.summary.ok} ok, ${result.summary.info} info, ${result.summary.warn} warn, ${result.summary.error} error`,
  );
  for (const finding of result.findings) {
    console.log(renderFinding(finding));
  }
}

process.exit(result.exitCode);
