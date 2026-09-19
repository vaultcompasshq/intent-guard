#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  CONFIG_PROPOSAL_LINE,
  appendDriftEvent,
  formatDriftMessage,
  loadConfig,
  loadTrustedControls,
  scoreDrift,
} from "@vaultcompass/intent-guard-core";
import { assertValidIntentContract } from "@vaultcompass/intent-guard-schema";
import {
  isHelpFlag,
  isVersionFlag,
  listValueAt,
  missingValue,
  printUsage,
  printVersion,
} from "./usage.js";

const USAGE = `Usage: intent-guard drift --contract <path> [flags]

Score drift for a specific contract file. Scoring only: this does not evaluate
the Change Budget. Use intent-guard check to enforce.

Flags:
  --contract <path>    Contract file to score (required)
  --project <root>     Project root for config and logs (default: .)
  --trust-base <ref>   Pull-request mode: take the drift thresholds from <ref>
  --paths a,b          Changed paths
  --signals "x,y"      Free-text descriptions of what changed
  --message "<text>"   Latest user message
  --log                Append the result to the drift log
  --help, -h           Show this help
  --version, -v        Print the version

--trust-base belongs here because intent-guard drift --ci turns this score
into an exit code, and the thresholds that decide it live in a file a pull
request can edit. The contract is named explicitly with --contract, so it is
the caller's own choice on either side and is never read from the ref. A ref
that will not resolve exits 2, and a changed config is noted on stderr so
stdout stays parseable JSON.`;

// A usage error is not a help request: it goes to stderr and exits non-zero,
// naming the offending argument rather than leaving the reader to diff their
// command against the usage by eye.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

// The flags that take a value and drop into the trailing arm when it is
// missing. The scalar ones are parsed by the `&& argv[i + 1]` arms below; the
// list ones use listValueAt, which accepts an empty string and refuses a
// following flag. --trust-base is deliberately absent: it checks its own value
// and answers for itself, and listing it here would change what it accepts.
const VALUE_FLAGS = new Set([
  "--contract",
  "--project",
  "--paths",
  "--signals",
  "--message",
]);

function parseArgs(argv: string[]) {
  let contractPath = "";
  let projectRoot = ".";
  let trustBase = "";
  const paths: string[] = [];
  const signals: string[] = [];
  let userMessage = "";
  let log = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--contract" && argv[i + 1]) {
      contractPath = argv[++i];
    } else if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--trust-base") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        console.error(USAGE);
        process.exit(1);
      }
      trustBase = next;
      i++;
    } else if (arg === "--paths" && listValueAt(argv, i) !== undefined) {
      paths.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--signals" && listValueAt(argv, i) !== undefined) {
      signals.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--message" && argv[i + 1]) {
      userMessage = argv[++i];
    } else if (arg === "--log") {
      log = true;
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    } else if (VALUE_FLAGS.has(arg)) {
      // A known flag that arrived without its value, before the arm below.
      // `--paths ""` does not reach here: an empty list is a value, and it is
      // the one a pull-request runner sends when the diff against the base is
      // empty. See the longer note in check-cli.ts.
      badUsage(missingValue(arg));
    } else {
      // Refused rather than dropped. See the longer note in check-cli.ts. It
      // bites hardest here, because this command's own thresholds come from
      // the ref `--trust-base` names: a silently ignored `--trust-bse` scored
      // against whatever the head carried and answered `proceed` where the
      // same run with the flag answers `hard_block`.
      badUsage(`unknown option '${arg}'`);
    }
  }

  return {
    contractPath,
    projectRoot,
    trustBase,
    paths,
    signals,
    userMessage,
    log,
    help,
    version,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

if (!args.contractPath) {
  console.error(
    "Usage: intent-guard-drift --contract <path> [--project <root>] [--paths a,b] [--signals x] [--message text] [--log]",
  );
  process.exit(1);
}

const raw = parse(readFileSync(args.contractPath, "utf8"));
const contract = assertValidIntentContract(raw);

// The thresholds, and only the thresholds, move to the base ref. The contract
// was named by the caller, so it is already outside the file set a pull
// request could quietly swap.
const trusted = args.trustBase
  ? loadTrustedControls(args.projectRoot, args.trustBase)
  : null;
const config = trusted === null ? loadConfig(args.projectRoot) : trusted.config;
if (trusted !== null && trusted.configChanged) {
  // stderr, because stdout is JSON that intent-guard drift --ci parses.
  console.error(`intent-guard: ${CONFIG_PROPOSAL_LINE} (scored against ${trusted.ref})`);
}

const score = scoreDrift(
  contract,
  {
    changedPaths: args.paths,
    signals: args.signals,
    userMessage: args.userMessage,
  },
  {
    thresholds: config.drift.thresholds,
    hard_block_on_critical_constraints:
      config.drift.hard_block_on_critical_constraints,
  },
);

if (args.log) {
  appendDriftEvent(args.projectRoot, {
    contract_id: contract.contract_id,
    overall: score.overall,
    action: score.action,
    findings: score.findings,
    changed_paths: args.paths,
    user_message: args.userMessage || undefined,
  });
}

console.log(
  JSON.stringify({
    overall: score.overall,
    action: score.action,
    categories: score.categories,
    findings: score.findings,
    message: formatDriftMessage(score),
    block: score.action === "soft_block" || score.action === "hard_block",
  }),
);
