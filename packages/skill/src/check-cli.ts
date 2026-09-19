#!/usr/bin/env node
import {
  appendDriftEvent,
  checkGate,
  crossSessionDrift,
  formatDriftMessage,
  loadTrustedControls,
  readArchivedContract,
  readArchivedContractAtRef,
  readContract,
} from "@vaultcompass/intent-guard-core";
import { collectChangedPaths } from "./changed-paths.js";
import { isHelpFlag, isVersionFlag, missingValue, printUsage, printVersion } from "./usage.js";

const USAGE = `Usage: intent-guard check [flags]

Run the enforcement gate against changed paths. Exits non-zero when the gate
blocks the change.

Flags:
  --project <root>            Project root (default: .)
  --staged                    Collect staged paths from git
  --base <ref>                Collect paths changed since the merge base with <ref>
  --trust-base <ref>          Pull-request mode: read every control input
                              (contract, config, contracts archive) from <ref>
  --paths a,b                 Explicit changed paths
  --signals "x,y"             Free-text descriptions of what changed
  --message "<text>"          Latest user message
  --previous-contract <id>    Include prior-contract drift context
  --no-require-frozen         Allow a missing or unfrozen contract
  --log                       Append the result to the drift log
  --json                      Machine-readable output
  --help, -h                  Show this help
  --version, -v               Print the version

--base is additive with --paths and --staged. It fails closed: an unknown ref
or a missing merge base exits 2 rather than gating on an empty path set.

--trust-base decides WHERE THE RULES COME FROM; --base decides which paths are
judged. They are independent, and a pull-request run passes both. Under
--trust-base a contract or config the head changed is reported and ignored,
and a contract change that also grants itself a new approval is refused. It
fails closed the same way: a ref that will not resolve exits 2.`;

// A usage error is not a help request: it goes to stderr and exits non-zero.
// The offending argument is named when there is one, because "here is the
// usage" leaves the reader to diff their command against it by eye.
function badUsage(reason?: string): never {
  if (reason) console.error(`error: ${reason}`);
  console.error(USAGE);
  process.exit(1);
}

// The flags that take a value and are parsed by the `&& argv[i + 1]` arms
// below, which drop a flag whose value is missing or empty into the trailing
// arm. --base and --trust-base are deliberately absent: they check their own
// value and answer for themselves, and listing them here would change what
// they accept.
const VALUE_FLAGS = new Set([
  "--project",
  "--paths",
  "--signals",
  "--message",
  "--previous-contract",
]);

function parseArgs(argv: string[]) {
  let projectRoot = ".";
  const paths: string[] = [];
  const signals: string[] = [];
  let userMessage = "";
  let staged = false;
  let base = "";
  let trustBase = "";
  let requireFrozen = true;
  let json = false;
  let log = false;
  let previousContract = "";
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === "--paths" && argv[i + 1]) {
      paths.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--signals" && argv[i + 1]) {
      signals.push(...argv[++i].split(",").filter(Boolean));
    } else if (arg === "--message" && argv[i + 1]) {
      userMessage = argv[++i];
    } else if (arg === "--staged") {
      staged = true;
    } else if (arg === "--base") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) badUsage();
      base = next;
      i++;
    } else if (arg === "--trust-base") {
      // Same shape as --base, and for the same reason: a missing value here
      // would otherwise silently mean "not in pull-request mode", which is the
      // permissive reading of a typo.
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) badUsage();
      trustBase = next;
      i++;
    } else if (arg === "--no-require-frozen") {
      requireFrozen = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--log") {
      log = true;
    } else if (arg === "--previous-contract" && argv[i + 1]) {
      previousContract = argv[++i];
    } else if (isHelpFlag(arg)) {
      help = true;
    } else if (isVersionFlag(arg)) {
      version = true;
    } else if (VALUE_FLAGS.has(arg)) {
      // A known flag that arrived without its value. It has to be answered
      // before the arm below, which would otherwise report a flag printed in
      // this command's own usage text as one that does not exist. `--paths ""`
      // is the case that reaches CI: a workflow building the path list from a
      // diff hands over an empty string whenever the diff is empty.
      badUsage(missingValue(arg));
    } else {
      // ANYTHING UNRECOGNISED IS REFUSED, and this arm is the point of the
      // whole chain rather than tidiness at the end of it.
      //
      // Without it the loop dropped an unknown argument silently, which turned
      // a typo into a QUIETER RUN instead of an error. `--trust-bse origin/main`
      // left trustBase empty, so the gate read its control inputs from the head
      // rather than from the base ref, scored against whatever thresholds the
      // head carried, and reported a pass -- while the workflow that asked for
      // pull-request mode looked like it had got it. A fail-open, and the
      // measurements in trust-base.test.ts show the same run answering
      // hard_block with the flag and proceed without it.
      //
      // A bare word is refused for the same reason. `intent-guard check
      // src/foo.ts` looks like it checks that path and checks nothing, because
      // paths arrive through `--paths`.
      badUsage(`unknown option '${arg}'`);
    }
  }

  return {
    projectRoot,
    paths,
    signals,
    userMessage,
    staged,
    base,
    trustBase,
    requireFrozen,
    json,
    log,
    previousContract,
    help,
    version,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printUsage(USAGE);
if (args.version) printVersion();

const changedPaths = collectChangedPaths({
  projectRoot: args.projectRoot,
  paths: args.paths,
  staged: args.staged,
  base: args.base,
});

const result = checkGate(args.projectRoot, {
  requireFrozen: args.requireFrozen,
  ...(args.trustBase ? { trustBase: args.trustBase } : {}),
  signals: {
    changedPaths,
    signals: args.signals,
    userMessage: args.userMessage || undefined,
  },
});

const crossSession =
  args.previousContract
    ? (() => {
        // Both sides from the same ref as the gate used. Comparing a base
        // archive against a head contract would score the drift of the
        // proposal rather than of the change under judgment.
        const previous = args.trustBase
          ? readArchivedContractAtRef(
              args.projectRoot,
              args.trustBase,
              args.previousContract,
            )
          : readArchivedContract(args.projectRoot, args.previousContract);
        const current = args.trustBase
          ? loadTrustedControls(args.projectRoot, args.trustBase).contract
          : readContract(args.projectRoot);
        if (!previous || !current) return null;
        return crossSessionDrift(previous, current, {
          changedPaths,
          signals: args.signals,
          userMessage: args.userMessage || undefined,
        });
      })()
    : null;

if (args.log && result.drift) {
  appendDriftEvent(args.projectRoot, {
    contract_id: "gate-check",
    overall: result.drift.overall,
    action: result.drift.action,
    findings: result.drift.findings,
    changed_paths: changedPaths,
    user_message: args.userMessage || undefined,
  });
}

/**
 * The proposal lines go with the verdict, in the same stream as the rest of
 * the human output, because "this pull request also proposes to loosen the
 * gate" is part of the verdict rather than a footnote to it. In --json mode
 * they are already on the result and are not printed twice.
 */
function proposalLines(): string[] {
  const trust = result.trustBase;
  if (!trust) return [];
  return [
    `  control inputs from: ${trust.ref}`,
    ...trust.proposals.map((proposal) => `  proposed: ${proposal}`),
  ];
}

if (args.json) {
  console.log(JSON.stringify({ ...result, crossSessionDrift: crossSession }));
} else if (result.status === "blocked") {
  console.error("✖ Intent Guard gate: BLOCKED");
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  for (const line of proposalLines()) console.error(line);
  if (result.drift) {
    console.error("");
    console.error(formatDriftMessage(result.drift));
  }
} else {
  console.log("✓ Intent Guard gate: ok");
  for (const line of proposalLines()) console.log(line);
  if (result.drift && result.drift.action !== "proceed") {
    console.log(`  drift: ${result.drift.action} (${result.drift.overall}/100)`);
  }
  if (crossSession && crossSession.previous.action !== "proceed") {
    console.log(
      `  prior-contract drift: ${crossSession.previous.action} (${crossSession.previous.overall}/100 vs ${crossSession.previous_contract_id})`,
    );
  }
}

process.exit(result.exitCode);
