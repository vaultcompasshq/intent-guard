#!/usr/bin/env node
import { stringify } from "yaml";
import {
  importSpecContract,
  loadAllConstraints,
  writeContract,
} from "@vaultcompass/intent-guard-core";
import {
  isHelpFlag,
  isVersionFlag,
  missingValue,
  pathSuggestionLine,
  printUsage,
  printVersion,
} from "./usage.js";

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
  --verbose                 Say on stderr which near-duplicate item each
                            kept item replaced
  --help, -h                Show this help
  --version, -v             Print the version

superpowers imports the spec as requirements and the plan as tasks. With no
--spec, it takes the newest markdown file in docs/superpowers/specs and the
plan in docs/superpowers/plans whose stem matches, with a trailing -design
stripped. --plan without --spec is an error, and so is --spec or --plan
combined with --from spec-kit, --from kiro, or --spec-dir.`;

const REVIEW_NOTICE =
  "Review each item; polarity is inferred from headings and modals and may be wrong.";

// A usage error is not a help request: it goes to stderr and exits non-zero.
// The offending argument is named when there is one, because "here is the
// usage" leaves the reader to diff their command against it by eye.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

// The flags that take a value. Reaching the arm below with one of these means
// the value was missing or empty, which is a different mistake from a flag
// that does not exist and gets a different sentence.
const VALUE_FLAGS = new Set([
  "--project",
  "--from",
  "--spec",
  "--plan",
  "--spec-dir",
  "--requirements",
  "--design",
  "--tasks",
]);

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
  let verbose = false;
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
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    } else if (VALUE_FLAGS.has(arg)) {
      // A known flag that arrived without its value, before the arm below.
      badUsage(missingValue(arg));
    } else {
      // This command already refused an unknown argument; it just never said
      // which one.
      badUsage(`unknown option '${arg}'`);
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
    verbose,
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

  // Every item the importer inferred, in both lists, in front of the person
  // about to freeze them. Which list an item lands in is read from the spec's
  // headings ("Non-goals", "Background") and from modal verbs, and that
  // reading can be wrong in either direction, so "review the draft" is not
  // enough: a non-goal that landed in in_scope authorises exactly what the
  // spec ruled out. stderr, so stdout stays one JSON document.
  const reviewLines = [
    REVIEW_NOTICE,
    "in_scope:",
    ...(contract.in_scope.length > 0 ? contract.in_scope.map((item) => `  - ${item}`) : ["  (none)"]),
    "out_of_scope:",
    ...(contract.out_of_scope.length > 0
      ? contract.out_of_scope.map((item) => `  - ${item}`)
      : ["  (none)"]),
  ];
  console.error(reviewLines.join("\n"));
  for (const warning of imported.warnings) console.error(`warning: ${warning}`);
  if (imported.pathSuggestions.length > 0) console.error(pathSuggestionLine(imported.pathSuggestions));
  const replaced = [...(loaded.replaced ?? []), ...imported.replaced];
  if (args.verbose) {
    for (const entry of replaced) {
      console.error(`replaced: "${entry.replaced}" (kept "${entry.kept}")`);
    }
  }

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
      next_step:
        "Review each in_scope and out_of_scope item (move or delete any that landed in the wrong list), then approve with: intent-guard freeze --project <root> --approved-by <name>",
      review: {
        notice: REVIEW_NOTICE,
        in_scope: contract.in_scope,
        out_of_scope: contract.out_of_scope,
      },
      loaded_constraint_files: loaded.loadedFiles,
      sections: imported.sections,
      warnings: imported.warnings,
      suggested_allowed_paths: imported.pathSuggestions,
      replaced,
      contract_yaml: stringify(contract),
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
