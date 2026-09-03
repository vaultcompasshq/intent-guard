#!/usr/bin/env node
import { stringify } from "yaml";
import {
  importSpecContract,
  loadAllConstraints,
  writeContract,
} from "@vaultcompass/intent-guard-core";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard import-spec [flags]

Import Spec Kit, Kiro, or superpowers artifacts as an unfrozen Intent Contract
draft.

Flags:
  --project <root>          Project root (default: .)
  --from <format>           auto|spec-kit|kiro|superpowers (default: auto)
  --spec-dir <dir>          Directory holding the spec artifacts
  --requirements <path>     Explicit requirements file
  --design <path>           Explicit design file
  --tasks <path>            Explicit tasks file
  --spec <path>             superpowers: the design spec markdown file
  --plan <path>             superpowers: the plan markdown file
  --dry-run                 Print the draft without writing it
  --help, -h                Show this help
  --version, -v             Print the version

superpowers imports the spec as requirements and the plan as tasks. With no
--spec, it takes the newest markdown file in docs/superpowers/specs and the
plan in docs/superpowers/plans whose stem matches, with a trailing -design
stripped. --plan without --spec is an error, and so is --spec or --plan
combined with --from spec-kit, --from kiro, or --spec-dir.`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
function badUsage(): never {
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let format: "auto" | "spec-kit" | "kiro" | "superpowers" = "auto";
  let specDir = "";
  let requirementsPath = "";
  let designPath = "";
  let tasksPath = "";
  let specPath = "";
  let planPath = "";
  let dryRun = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--from" && argv[i + 1]) {
      const next = argv[++i];
      if (
        next !== "auto" &&
        next !== "spec-kit" &&
        next !== "kiro" &&
        next !== "superpowers"
      ) {
        badUsage();
      }
      format = next;
    } else if (arg === "--spec" && argv[i + 1]) {
      specPath = argv[++i];
    } else if (arg === "--plan" && argv[i + 1]) {
      planPath = argv[++i];
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

  // --spec and --plan only mean anything for superpowers. Combined with a
  // spec-kit or kiro source they used to be dropped without a word, and the
  // command then built a contract from entirely different files. A flag that
  // is ignored silently is worse than one that is refused.
  const namesSuperpowersFiles = specPath !== "" || planPath !== "";
  if (namesSuperpowersFiles && (format === "spec-kit" || format === "kiro")) {
    badUsage();
  }
  if (namesSuperpowersFiles && specDir !== "") badUsage();

  return {
    projectRoot,
    format,
    specDir: specDir || undefined,
    requirementsPath: requirementsPath || undefined,
    designPath: designPath || undefined,
    tasksPath: tasksPath || undefined,
    specPath: specPath || undefined,
    planPath: planPath || undefined,
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
    specPath: args.specPath,
    planPath: args.planPath,
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
