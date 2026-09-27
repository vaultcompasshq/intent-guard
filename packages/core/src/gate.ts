import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { readContract, isContractFrozen, DEFAULT_CONTRACT_FILE } from "./contract-store.js";
import { scoreDrift, type DriftSignals, type DriftScore } from "./drift.js";
import { evaluateBudget, type BudgetResult } from "./budget.js";
import {
  describeBudgetPathIssue,
  validateBudgetPaths,
  type BudgetPathIssue,
} from "./budget-paths.js";
import { loadConfig } from "./config.js";
import { STATE_DIR } from "./state-dir.js";
import {
  controlShapeReason,
  loadTrustedControls,
  selfApprovalReason,
  type ControlShapeChange,
  type TrustedControls,
} from "./trust-base.js";

export type GateStatus = "ok" | "blocked";

/**
 * What pull-request mode did, carried on the result so a report never has to
 * work it out again from the inputs.
 */
export interface TrustBaseSummary {
  /** The ref every control input came from. */
  ref: string;
  /** One line per control input the head proposes to change. */
  proposals: string[];
  contractChanged: boolean;
  configChanged: boolean;
  /** Whether the base ref carried a contract at all. */
  baseContractFound: boolean;
  /** Whether this run refused a contract change that approved itself. */
  selfApproval: boolean;
  /**
   * How the head changed the contract file's type or mode, or null. Carried
   * separately from `proposals` so a consumer can act on the fact rather than
   * on the sentence.
   */
  contractShapeChange: ControlShapeChange | null;
}

export interface GateResult {
  status: GateStatus;
  /** Process exit code: 0 when ok, 1 when blocked. */
  exitCode: 0 | 1;
  reasons: string[];
  /**
   * Non-blocking notices: present on every result, empty when there is
   * nothing to warn about. Never affects `status` or `exitCode`. Carries a
   * deprecation-style notice from the gate itself, such as an already-frozen
   * contract whose `protected_paths` or `allowed_paths` entry is invalid --
   * refused at `freeze` and `import-spec` for a NEW contract, but only warned
   * about here through 1.x so an upgrade never starts blocking on its own
   * (see docs/release/stability-policy.md's deprecation rule). 2.0.0 turns
   * this into a blocking reason.
   */
  warnings: string[];
  contractFound: boolean;
  contractFrozen: boolean;
  drift?: DriftScore;
  budget?: BudgetResult;
  /** Present only on a pull-request run, so its absence means ordinary mode. */
  trustBase?: TrustBaseSummary;
}

export interface CheckGateOptions {
  /** Require a frozen contract to exist (the hard gate). Default true. */
  requireFrozen?: boolean;
  /** Drift inputs; when paths/signals are present, drift is scored too. */
  signals?: DriftSignals;
  /**
   * Pull-request mode. Every control input (the frozen contract, config.yaml,
   * the contracts archive) is read from this ref instead of from the tree
   * being judged. Absent means the ordinary trusted-checkout behaviour, which
   * is byte for byte what it was before this option existed.
   */
  trustBase?: string;
}

/**
 * Whether the changed set names the contract file.
 *
 * Matched on the suffix because git lists paths relative to the REPOSITORY
 * root while the contract is resolved relative to the PROJECT root, and the
 * two differ whenever --project points at a subdirectory. Under-matching here
 * would drop the self-approval refusal, so the loose end is deliberate.
 */
function changedSetNamesContract(changedPaths: string[]): boolean {
  return changedPaths.some(
    (path) =>
      path.endsWith(`/${DEFAULT_CONTRACT_FILE}`) || path === DEFAULT_CONTRACT_FILE,
  );
}

/**
 * The single enforcement point. Unlike a SKILL.md instruction an agent may
 * ignore, this returns a non-zero exit code a pre-commit hook or CI step can
 * act on. Two independent gates:
 *
 *   1. A frozen Intent Contract must exist (intent fidelity has a baseline).
 *   2. Scored drift must not reach a blocking threshold.
 */
export function checkGate(
  projectRoot: string,
  options: CheckGateOptions = {},
): GateResult {
  const requireFrozen = options.requireFrozen ?? true;

  // Pull-request mode is entered here and nowhere else. Both throwing paths
  // below (a ref that will not resolve, a base config the schema refuses) are
  // could-not-run, and both reach the CLI as exit 2 rather than as a verdict.
  const trusted: TrustedControls | null =
    options.trustBase === undefined || options.trustBase === ""
      ? null
      : loadTrustedControls(projectRoot, options.trustBase);

  const config = trusted === null ? loadConfig(projectRoot) : trusted.config;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // The head's own budget is never judged -- the base governs this run --
  // but a defect in what the head proposes is worth naming now: merging it
  // as-is would freeze (or already has frozen) a contract that enforces
  // nothing for that entry, and lock every later check after merge. This is
  // a diagnostic on the proposal line, not a reason, so it never changes the
  // exit code below.
  //
  // Skipped when the head's issues are exactly the base's: an unchanged
  // defect is not something THIS pull request is proposing, it is inherited,
  // and it is already named once as a blocking reason (below) whenever the
  // base itself is invalid. Without this, an untouched bad contract reported
  // the same entry twice, as a proposal and as a reason, which reads as the
  // pull request having introduced it.
  const sameBudgetIssues = (a: BudgetPathIssue[], b: BudgetPathIssue[]): boolean =>
    a.length === b.length &&
    a.every(
      (issue, i) =>
        issue.rule === b[i].rule && issue.value === b[i].value && issue.reason === b[i].reason,
    );
  const headBudgetIssues =
    trusted !== null && trusted.headContract
      ? validateBudgetPaths(trusted.headContract.budget)
      : [];
  const baseBudgetIssues =
    trusted !== null && trusted.contract ? validateBudgetPaths(trusted.contract.budget) : [];
  const headBudgetProposals = sameBudgetIssues(headBudgetIssues, baseBudgetIssues)
    ? []
    : headBudgetIssues.map((issue) => `proposed budget invalid: ${describeBudgetPathIssue(issue)}`);

  // Present only in pull-request mode, and mutated in exactly one place below.
  const summary: TrustBaseSummary | null =
    trusted === null
      ? null
      : {
          ref: trusted.ref,
          proposals: [...trusted.proposals, ...headBudgetProposals],
          contractChanged: trusted.contractChanged,
          configChanged: trusted.configChanged,
          baseContractFound: trusted.contract !== null || trusted.contractError !== null,
          selfApproval: false,
          contractShapeChange: trusted.contractShapeChange,
        };
  const withSummary = <T extends object>(result: T): T =>
    summary === null ? result : { ...result, trustBase: summary };

  let contract: IntentContract | null = null;
  if (trusted === null) {
    try {
      contract = readContract(projectRoot);
    } catch (err) {
      return {
        status: "blocked",
        exitCode: 1,
        reasons: [`Intent contract is invalid: ${(err as Error).message}`],
        warnings: [],
        contractFound: true,
        contractFrozen: false,
      };
    }
  } else if (trusted.contractError !== null) {
    // The BASE contract is the broken one. Reported with the same prefix as
    // the head-side case, because it is the same fact about the same file.
    return withSummary({
      status: "blocked" as const,
      exitCode: 1 as const,
      reasons: [`Intent contract is invalid: ${trusted.contractError.message}`],
      warnings: [],
      contractFound: true,
      contractFrozen: false,
    });
  } else {
    contract = trusted.contract;
  }

  const contractFound = contract !== null;
  const contractFrozen = contract !== null && isContractFrozen(contract);

  if (!contractFound) {
    if (requireFrozen) {
      reasons.push(
        `No ${STATE_DIR}/intent-contract.yaml found. Draft intent with intent-guard-extract, then approve with intent-guard-freeze before implementing.`,
      );
    }
    // First adoption on the branch. The head's contract is a proposal and is
    // already reported as one; it is deliberately NOT called self-approval,
    // because writing a first contract is the normal way to adopt the tool
    // and naming it an attack would teach people to bypass the gate.
    return withSummary({
      status: requireFrozen ? ("blocked" as const) : ("ok" as const),
      exitCode: requireFrozen ? (1 as const) : (0 as const),
      reasons,
      warnings,
      contractFound,
      contractFrozen,
    });
  }

  if (requireFrozen && !contractFrozen) {
    reasons.push(
      "Intent contract exists but is not frozen by user. Approve and freeze before implementing.",
    );
  }

  // A protected/allowed path that cannot possibly match anything is exactly
  // the miss this gate exists to catch, so it is never silently ignored.
  // intent-guard extract, import-spec, and freeze all validate an entry as it
  // is written (see budget-paths.ts) and refuse a NEW one with this shape,
  // but this contract may predate that validation or have been hand-edited
  // after freezing, so the gate checks again here, independent of whether
  // there is a diff to evaluate the budget against.
  //
  // This is a warning, not a blocking reason, through 1.x: PR #109 made this
  // a blocking reason outright, but a schema-valid frozen contract carrying
  // one of these shapes passed every check before that PR merged, so turning
  // it into a hard block on upgrade would freeze every later check on a
  // contract nobody re-approved. docs/release/stability-policy.md's
  // deprecation rule applies (one minor release with warnings, then
  // enforcement in the next major), so 1.7.0 warns, naming the entry and the
  // reason, and 2.0.0 turns this into a blocking reason.
  if (contract) {
    const budgetPathIssues = validateBudgetPaths(contract.budget);
    for (const issue of budgetPathIssues) {
      warnings.push(
        `Budget ${describeBudgetPathIssue(issue)}. This will block check and report starting in 2.0.0; edit the contract and run intent-guard freeze again before then.`,
      );
    }
  }

  // The single most important line in pull-request mode. A contract change is
  // legitimate and must stay possible, so the refusal is narrower than "the
  // contract is in the diff": it fires when the diff ALSO hands the contract a
  // different approval, which is the pull request approving itself. The
  // approval that counts is the base ref's, which the pull request cannot
  // write. Only when the gate is enforcing a frozen contract: with enforcement
  // off the change is reported and judged against the base, never refused.
  if (
    summary !== null &&
    trusted !== null &&
    requireFrozen &&
    trusted.headContractFound &&
    (trusted.contractChanged ||
      changedSetNamesContract(options.signals?.changedPaths ?? [])) &&
    trusted.approvalDiffers &&
    // A shape change gets its own, more specific refusal below. Saying "the
    // approval differs" about a contract that is now a symlink is true and
    // useless: the approval differs because there is no longer a contract to
    // read one from.
    trusted.contractShapeChange === null
  ) {
    summary.selfApproval = true;
    reasons.push(selfApprovalReason(trusted.ref));
  }

  // A change to WHAT THE CONTRACT PATH IS, rather than to what the contract
  // says. A symlink, a directory, a deletion, or a mode-bit change: none of
  // them is a contract, and none of them shows up in a content comparison. It
  // is refused on the same terms as self-approval, only while the gate is
  // enforcing a frozen contract, because with enforcement off there is no
  // approval to protect and reporting it is enough.
  if (trusted !== null && requireFrozen && trusted.contractShapeChange !== null) {
    reasons.push(controlShapeReason(trusted.ref, trusted.contractShapeChange));
  }

  let drift: DriftScore | undefined;
  const hasDriftInput =
    (options.signals?.changedPaths?.length ?? 0) > 0 ||
    (options.signals?.signals?.length ?? 0) > 0 ||
    !!options.signals?.userMessage;

  if (contract && hasDriftInput) {
    drift = scoreDrift(contract, options.signals ?? {}, {
      thresholds: config.drift.thresholds,
      hard_block_on_critical_constraints:
        config.drift.hard_block_on_critical_constraints,
    });
    if (drift.action === "soft_block" || drift.action === "hard_block") {
      reasons.push(
        `Drift ${drift.action} (score ${drift.overall}/100). Resolve drift or log an acknowledged pivot before continuing.`,
      );
    }
  }

  let budget: BudgetResult | undefined;
  const changedPaths = options.signals?.changedPaths ?? [];
  if (contract && contract.budget && changedPaths.length > 0) {
    budget = evaluateBudget(contract, changedPaths);
    if (budget.action !== "ok") {
      for (const violation of budget.violations) {
        reasons.push(`Budget ${violation.severity}: ${violation.message}`);
      }
    }
  }

  const blocked = reasons.length > 0;
  return withSummary({
    status: blocked ? ("blocked" as const) : ("ok" as const),
    exitCode: blocked ? (1 as const) : (0 as const),
    reasons,
    warnings,
    contractFound,
    contractFrozen,
    drift,
    budget,
  });
}
