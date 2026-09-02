#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import {
  coachMessage,
  draftContract,
  loadAllConstraints,
  loadConfig,
  scorePrompt,
  writeContract,
} from "@vaultcompass/intent-guard-core";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import { isHelpFlag, isVersionFlag, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard extract --text <user ask> [flags]

Draft an unfrozen Intent Contract from an ask. Approval is a separate step:
review the draft, then run intent-guard freeze.

Flags:
  --text <user ask>   The ask to draft a contract from (required)
  --project <root>    Project root (default: .)
  --dry-run           Print the draft without writing it
  --help, -h          Show this help
  --version, -v       Print the version`;

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  let userText = "";
  let dryRun = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--text" && argv[i + 1]) {
      userText = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--freeze") {
      console.error(
        "intent-guard-extract --freeze was removed. Extract only writes unfrozen drafts.\n" +
          "Review the draft, then approve with: intent-guard-freeze --project <root> [--approved-by <name>]",
      );
      process.exit(2);
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    }
  }

  return { projectRoot, userText, dryRun, help, version };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

if (!args.userText) {
  console.error(
    "Usage: intent-guard-extract --text <user ask> [--project <root>] [--dry-run]",
  );
  process.exit(1);
}

const loaded = loadAllConstraints(args.projectRoot);
const config = loadConfig(args.projectRoot);
const draft = draftContract({
  userText: args.userText,
  constraints: loaded.constraints,
});
const scored = scorePrompt(args.userText, {
  constraints: loaded.constraints.map((c) => c.rule),
  hasAcceptanceCriteria: /\b(verify|test|should|must|done)\b/i.test(args.userText),
});
const coaching = coachMessage(scored, args.userText);
// extract only ever writes an UNFROZEN draft. Approval is a separate,
// deliberate step: intent-guard-freeze.
const contract = draft;
const validation = validateIntentContract(contract);
const needsCoaching =
  scored.score < config.coach.show_when_score_below || scored.issues.length > 0;

let writtenPath: string | null = null;
if (!args.dryRun && validation.valid) {
  writtenPath = writeContract(args.projectRoot, contract);
}

console.log(
  JSON.stringify({
    valid: validation.valid,
    errors: validation.errors,
    written_path: writtenPath,
    frozen: false,
    next_step: "Review the draft, then approve with: intent-guard-freeze --project <root> [--approved-by <name>]",
    loaded_constraint_files: loaded.loadedFiles,
    prompt_score: scored.score,
    needs_coaching: needsCoaching,
    coaching,
    contract_yaml: stringify(contract),
  }),
);
