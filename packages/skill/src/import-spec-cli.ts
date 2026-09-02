#!/usr/bin/env node
import { stringify } from "yaml";
import {
  importSpecContract,
  loadAllConstraints,
  writeContract,
} from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard import-spec [flags]

Import Spec Kit or Kiro artifacts as an unfrozen Intent Contract draft.

Flags:
  --project <root>          Project root (default: .)
  --from auto|spec-kit|kiro Source format (default: auto)
  --spec-dir <dir>          Directory holding the spec artifacts
  --requirements <path>     Explicit requirements file
  --design <path>           Explicit design file
  --tasks <path>            Explicit tasks file
  --dry-run                 Print the draft without writing it
  --help, -h                Show this help
  --version, -v             Print the version`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
function badUsage(): never {
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let format: "auto" | "spec-kit" | "kiro" = "auto";
  let specDir = "";
  let requirementsPath = "";
  let designPath = "";
  let tasksPath = "";
  let dryRun = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--from" && argv[i + 1]) {
      const next = argv[++i];
      if (next !== "auto" && next !== "spec-kit" && next !== "kiro") badUsage();
      format = next;
    } else if (arg === "--spec-dir" && argv[i + 1]) {
      specDir = argv[++i];
    } else if (arg === "--requirements" && argv[i + 1]) {
      requirementsPath = argv[++i];
    } else if (arg === "--design" && argv[i + 1]) {
      designPath = argv[++i];
    } else if (arg === "--tasks" && argv[i + 1]) {
      tasksPath = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    } else {
      badUsage();
    }
  }

  return {
    projectRoot,
    format,
    specDir: specDir || undefined,
    requirementsPath: requirementsPath || undefined,
    designPath: designPath || undefined,
    tasksPath: tasksPath || undefined,
    dryRun,
    help,
    version,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

try {
  const imported = importSpecContract(args.projectRoot, {
    format: args.format,
    specDir: args.specDir,
    requirementsPath: args.requirementsPath,
    designPath: args.designPath,
    tasksPath: args.tasksPath,
  });

  const loaded = loadAllConstraints(args.projectRoot);
  const contract = {
    ...imported.contract,
    constraints: loaded.constraints,
  };

  const writtenPath = args.dryRun ? null : writeContract(args.projectRoot, contract);
  console.log(
    JSON.stringify({
      valid: true,
      format: imported.format,
      spec_dir: imported.specDir,
      imported_files: imported.files.map((file) => ({
        role: file.role,
        path: file.path,
      })),
      written_path: writtenPath,
      frozen: false,
      next_step: "Review the imported draft, then approve with: intent-guard freeze --project <root> --approved-by <name>",
      loaded_constraint_files: loaded.loadedFiles,
      contract_yaml: stringify(contract),
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
