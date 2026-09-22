import { readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import {
  assertValidIntentContract,
  type IntentContract,
} from "@vaultcompass/intent-guard-schema";
import { archiveContract } from "./history.js";
import { LEGACY_STATE_DIR, ensureStateDir, stateDir } from "./state-dir.js";

/**
 * The pre-1.3.0 state directory name, `.conductor`.
 *
 * @deprecated since 1.3.0. Use `STATE_DIR` for the directory this tool now
 * writes, or `LEGACY_STATE_DIR`, which this aliases, for the old name. Its
 * value is frozen at what it meant in 1.2 so that code compiled against it
 * keeps behaving the same for one minor release. Removed in 2.0.
 */
export const CONDUCTOR_DIR = LEGACY_STATE_DIR;
export const DEFAULT_CONTRACT_FILE = "intent-contract.yaml";

/**
 * The pre-1.3.0 state directory path, `<projectRoot>/.conductor`.
 *
 * @deprecated since 1.3.0. Use `stateDir()` to resolve the directory to read
 * from, or `ensureStateDir()` for the directory to write to. This is a plain
 * join, frozen at its 1.2 behaviour: it does not resolve between the two
 * directory names, never writes to stderr, and never throws. Removed in 2.0.
 */
export function conductorDir(projectRoot: string): string {
  return join(projectRoot, LEGACY_STATE_DIR);
}

export function contractPath(
  projectRoot: string,
  filename = DEFAULT_CONTRACT_FILE,
): string {
  return join(stateDir(projectRoot), filename);
}

/**
 * Why a contract path that is not a regular file is refused, said once.
 *
 * Lives here, on the side that both readers already depend on, so the sentence
 * a user gets does not depend on whether the trusted read or the base-versus-
 * head comparison noticed first. `isSymlink` rather than a git mode, because
 * one caller has an lstat and the other has a tree entry, and neither should
 * have to speak the other's vocabulary to ask for this string.
 */
export function notAFileMessage(path: string, isSymlink: boolean): string {
  return (
    `the contract path ${path} is ${isSymlink ? "a symlink" : "not a regular file"}. ` +
    "Intent Guard will not follow a link to a contract: the file it points at is " +
    "not the file anyone approved, and a later edit to the link target would " +
    "change the contract without the contract path ever appearing in the diff. " +
    "Replace it with a regular file."
  );
}

/**
 * The active contract, or null when the project has none.
 *
 * The contract path must be a REGULAR FILE, and lstat is what says so.
 * Following a link here is the second half of a two-step: one change turns
 * the contract into a symlink whose target holds the approved bytes, which no
 * content comparison can see, and a later change edits only the link target,
 * where the contract path itself never appears in the diff. Pull-request mode
 * refuses the first half; this refuses the second, on the trusted path where
 * pull-request mode is not in play at all.
 *
 * The refusal is an ordinary throw, so it reaches a user through the gate's
 * existing contract-invalid reason rather than as a new outcome to handle.
 * Without it the failure was the schema's "/ must be object" against a link
 * target string, which says nothing about the link.
 */
export function readContract(
  projectRoot: string,
  filename = DEFAULT_CONTRACT_FILE,
): IntentContract | null {
  const path = contractPath(projectRoot, filename);
  // lstat rather than existsSync, which follows links: a dangling symlink
  // reads as absent to existsSync, and "there is no contract" is the wrong
  // answer to "the contract is a broken link".
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    throw new Error(
      notAFileMessage(relative(projectRoot, path) || path, stat.isSymbolicLink()),
    );
  }
  const raw = parse(readFileSync(path, "utf8"));
  return assertValidIntentContract(raw);
}

export function writeContract(
  projectRoot: string,
  contract: IntentContract,
  filename = DEFAULT_CONTRACT_FILE,
): string {
  assertValidIntentContract(contract);
  const dir = ensureStateDir(projectRoot);
  const path = join(dir, filename);
  writeFileSync(path, stringify(contract), "utf8");
  if (
    filename === DEFAULT_CONTRACT_FILE &&
    contract.frozen_by === "user" &&
    contract.approval != null
  ) {
    archiveContract(projectRoot, contract);
  }
  return path;
}

export interface FreezeApproval {
  /** Identity of the approver -- required, so approval is attributable. */
  approvedBy: string;
  method?: "interactive" | "explicit-flag" | "forced";
}

/**
 * Freeze a contract under an explicit, attributable approval. Approval is no
 * longer a bare flag: an `approval` record (who/when/how) is always written, and
 * the gate requires it (see isContractFrozen). Software can't prove a human
 * approved in a headless run, but it can require a deliberate, recorded act
 * rather than a default of the drafting step.
 */
export function freezeContract(
  contract: IntentContract,
  approval: FreezeApproval,
): IntentContract {
  const now = new Date().toISOString();
  return {
    ...contract,
    frozen_at: now,
    frozen_by: "user",
    approval: {
      approved_by: approval.approvedBy,
      approved_at: now,
      method: approval.method ?? "explicit-flag",
    },
  };
}

/**
 * A contract is frozen only when a user approved it with an approval record.
 * `frozen_by: "user"` alone (e.g. hand-set in YAML) is not enough.
 */
export function isContractFrozen(contract: IntentContract): boolean {
  return contract.frozen_by === "user" && contract.approval != null;
}
