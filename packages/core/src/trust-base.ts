/**
 * Pull-request mode: read every control input from the base ref.
 *
 * The defect this closes, stated plainly. The gate's trust anchor was a file
 * inside the tree it was judging. A pull request could, in one commit, widen
 * `in_scope`, delete `budget.protected_paths`, write its own `frozen_by: user`
 * and its own `approval` block, and make the change all of that had forbidden.
 * The gate read the rewritten contract, agreed with it, and passed. The same
 * held for `config.yaml`, which had no schema at all.
 *
 * The fix is not a heuristic about which edits look suspicious. It is base
 * versus head, and it is plain git: on a pull-request run the CONTROL INPUTS
 * come from the base ref, and the head tree is the thing under judgment. A
 * control input that differs between the two never takes effect for the run,
 * and the report says it was proposed. Outside pull-request mode nothing
 * changes, because a pre-commit hook and a direct CLI run are already inside
 * the trust boundary.
 *
 * Three rules hold everything here together:
 *
 *  - READS ONLY, AND NEVER INTO THE REPOSITORY. `git show <ref>:<path>` and
 *    `git rev-parse`, both of which only read. No checkout switch, no stash,
 *    no temporary worktree, no write of any kind. A gate that moved the
 *    user's HEAD to do its job would be a worse bug than the one it fixes.
 *
 *  - FAIL CLOSED ON THE REF. A ref that will not resolve is could-not-run and
 *    exits 2. It is never a reason to fall back to the head, because falling
 *    back to the head is precisely the behaviour being removed, and it would
 *    be reachable by anyone who could make the base ref unfetchable.
 *
 *  - A MISSING PATH AT THE BASE IS NOT A FAILURE. It is the ordinary state of
 *    a branch adopting the tool for the first time, and it means "no control
 *    input", which the gate already knows how to report. The ref is verified
 *    first precisely so this case can be told apart from a broken ref.
 *
 * No temporary worktree is needed anywhere in this file, including for the
 * contracts archive. Every archive access is by contract id, which is a
 * single path, and a single path is what `git show` reads.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  assertValidIntentContract,
  type IntentContract,
} from "@vaultcompass/intent-guard-schema";
import { parseConfigText } from "./config.js";
import { DEFAULT_CONDUCTOR_CONFIG, type ConductorConfig } from "./config-types.js";
import { LEGACY_STATE_DIR, STATE_DIR } from "./state-dir.js";
import { CONFIG_FILE } from "./config.js";
import { DEFAULT_CONTRACT_FILE } from "./contract-store.js";

/**
 * A base ref this tool cannot judge against, described for a user. Every CLI
 * entry point catches this class, prints the one line, and exits 2.
 */
export class TrustBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustBaseError";
  }
}

/** The one line a report prints when the head proposes a different contract. */
export const CONTRACT_PROPOSAL_LINE = "contract changed in this pull request";

/** The one line a report prints when the head proposes a different config. */
export const CONFIG_PROPOSAL_LINE = "config changed in this pull request";

/**
 * The prefix of the self-approval refusal.
 *
 * Exported so the umbrella can classify the reason without matching prose it
 * would then have to keep in step with a reworded sentence, the way it already
 * classifies the three contract-state reasons by prefix.
 */
export const SELF_APPROVAL_REASON_PREFIX = "Self-approval refused:";

/**
 * State directory names to look for at the base ref, canonical first.
 *
 * The working tree's own resolution cannot answer this: the base ref may
 * predate the 1.3.0 rename, or a pull request may be the rename. Canonical
 * wins outright, which is the same order the tool uses everywhere else.
 */
const CONTROL_DIRS = [STATE_DIR, LEGACY_STATE_DIR] as const;

const CONTRACTS_SUBDIR = "contracts";

function gitFirstLine(error: unknown): string {
  const raw = (error as { stderr?: string | Buffer }).stderr;
  const fromGit = typeof raw === "string" ? raw : raw ? raw.toString("utf8") : "";
  const firstLine = fromGit
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return firstLine;
  return error instanceof Error ? error.message.split("\n")[0].trim() : String(error);
}

/**
 * Refuse the run unless the ref names a commit in this repository.
 *
 * Verified BEFORE any path is read, which is what lets a path that is simply
 * absent at the base be read as "no control input" rather than as a broken
 * setup. Without this order the two are the same non-zero exit from git.
 */
export function assertTrustBaseResolvable(projectRoot: string, ref: string): void {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new TrustBaseError(
      `intent-guard: cannot read control inputs from base ref "${ref}": ` +
        `${gitFirstLine(error)}. Nothing was checked. In CI, fetch the base ` +
        "branch (actions/checkout with fetch-depth: 0) before running the gate.",
    );
  }
}

/**
 * One file's contents at a ref, or null when the ref does not carry it.
 *
 * The `./` is load-bearing. It makes git resolve the path relative to the
 * working directory rather than to the repository root, so a project root
 * that is a subdirectory of the repository reads its own state directory
 * instead of one that happens to sit at the top of the repository.
 */
export function readFileAtRef(
  projectRoot: string,
  ref: string,
  relativePath: string,
): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:./${relativePath}`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export interface ControlFile {
  /** Path relative to the project root, as it exists at that side. */
  path: string;
  text: string;
}

/** A control file at the base ref, canonical state directory first. */
export function readControlFileAtRef(
  projectRoot: string,
  ref: string,
  filename: string,
): ControlFile | null {
  for (const dir of CONTROL_DIRS) {
    const path = `${dir}/${filename}`;
    const text = readFileAtRef(projectRoot, ref, path);
    if (text !== null) return { path, text };
  }
  return null;
}

/**
 * The same control file in the working tree.
 *
 * Read directly rather than through `stateDir()`, because this is only ever
 * used for the base-versus-head comparison and must not throw on the
 * both-directories conflict that `stateDir()` refuses: the conflict is the
 * gate's own error to raise, from the code path that already raises it.
 */
export function readControlFileAtHead(
  projectRoot: string,
  filename: string,
): ControlFile | null {
  for (const dir of CONTROL_DIRS) {
    const absolute = join(projectRoot, dir, filename);
    if (!existsSync(absolute)) continue;
    try {
      return { path: `${dir}/${filename}`, text: readFileSync(absolute, "utf8") };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether two control files differ in what they SAY.
 *
 * Compared as parsed documents rather than as bytes, so a reflowed list or a
 * changed quote style is not reported as a proposal to loosen the gate; a
 * report that cries wolf on whitespace is a report reviewers learn to skip.
 * When either side will not parse, the raw text is compared instead, which is
 * the fail-closed direction: an unparseable head contract is reported as a
 * change rather than quietly matching.
 */
function documentsDiffer(base: string | null, head: string | null): boolean {
  if (base === null && head === null) return false;
  if (base === null || head === null) return true;
  try {
    return JSON.stringify(parse(base) ?? null) !== JSON.stringify(parse(head) ?? null);
  } catch {
    return base !== head;
  }
}

function approvalOf(contract: IntentContract | null): string {
  if (contract === null || contract.approval == null) return "none";
  const approval = contract.approval;
  return JSON.stringify([
    approval.approved_by,
    approval.approved_at,
    approval.method ?? null,
    contract.frozen_by ?? null,
  ]);
}

/** A contract at a ref, or null when that ref carries none. */
function contractAtRef(
  projectRoot: string,
  ref: string,
): { contract: IntentContract | null; text: string | null; error: Error | null } {
  const file = readControlFileAtRef(projectRoot, ref, DEFAULT_CONTRACT_FILE);
  if (file === null) return { contract: null, text: null, error: null };
  try {
    return {
      contract: assertValidIntentContract(parse(file.text)),
      text: file.text,
      error: null,
    };
  } catch (error) {
    return { contract: null, text: file.text, error: error as Error };
  }
}

function headContract(projectRoot: string): {
  contract: IntentContract | null;
  text: string | null;
} {
  const file = readControlFileAtHead(projectRoot, DEFAULT_CONTRACT_FILE);
  if (file === null) return { contract: null, text: null };
  try {
    return { contract: assertValidIntentContract(parse(file.text)), text: file.text };
  } catch {
    return { contract: null, text: file.text };
  }
}

export interface TrustedControls {
  /** The ref every control input was taken from. */
  ref: string;
  /** The base ref's contract, or null when it carries none. */
  contract: IntentContract | null;
  /**
   * Set when the BASE contract exists but does not validate. Carried rather
   * than thrown so the gate reports it through its own contract-invalid
   * reason, with the same prefix a downstream consumer already matches.
   */
  contractError: Error | null;
  /** The base ref's config, validated, or the defaults when it carries none. */
  config: ConductorConfig;
  /** True when the head proposes a different contract. */
  contractChanged: boolean;
  /** True when the head proposes a different config. */
  configChanged: boolean;
  /** True when the head carries a contract at all. */
  headContractFound: boolean;
  /**
   * True when the head's approval block (or frozen_by) is not the base's.
   * On its own this is a fact, not a verdict: the gate decides what to do
   * with it, and only refuses when it is enforcing a frozen contract.
   */
  approvalDiffers: boolean;
  /** One line per control input the head proposes to change. */
  proposals: string[];
}

/**
 * Every control input for one pull-request run, taken from the base ref.
 *
 * Throws TrustBaseError when the ref will not resolve, and ConfigError when
 * the BASE config will not validate. Both are could-not-run: exit 2, nothing
 * judged. A base config that does not validate cannot be waved through by
 * falling back to the defaults, because the defaults may be looser than what
 * the project committed, and a gate that silently loosens itself when a file
 * is malformed is a gate anyone can loosen.
 */
export function loadTrustedControls(projectRoot: string, ref: string): TrustedControls {
  assertTrustBaseResolvable(projectRoot, ref);

  const base = contractAtRef(projectRoot, ref);
  const head = headContract(projectRoot);

  const baseConfigFile = readControlFileAtRef(projectRoot, ref, CONFIG_FILE);
  const headConfigFile = readControlFileAtHead(projectRoot, CONFIG_FILE);
  const config =
    baseConfigFile === null
      ? { ...DEFAULT_CONDUCTOR_CONFIG }
      : parseConfigText(baseConfigFile.text, `${ref}:${baseConfigFile.path}`);

  const contractChanged = documentsDiffer(base.text, head.text);
  const configChanged = documentsDiffer(
    baseConfigFile === null ? null : baseConfigFile.text,
    headConfigFile === null ? null : headConfigFile.text,
  );

  const proposals: string[] = [];
  if (contractChanged) proposals.push(CONTRACT_PROPOSAL_LINE);
  if (configChanged) proposals.push(CONFIG_PROPOSAL_LINE);

  return {
    ref,
    contract: base.contract,
    contractError: base.error,
    config,
    contractChanged,
    configChanged,
    headContractFound: head.text !== null,
    approvalDiffers: approvalOf(base.contract) !== approvalOf(head.contract),
    proposals,
  };
}

/** The refusal, naming the ref whose approval is the one that counts. */
export function selfApprovalReason(ref: string): string {
  return (
    `${SELF_APPROVAL_REASON_PREFIX} this pull request changes ` +
    `${STATE_DIR}/${DEFAULT_CONTRACT_FILE} and gives it an approval that is not ` +
    `the one on "${ref}". The approval that counts is the base ref's, which a ` +
    "pull request cannot write. Land the contract change on the base branch " +
    "first, or require a human approval for contract changes in the workflow."
  );
}

/** An archived contract at the base ref, by id. One path, so no worktree. */
export function readArchivedContractAtRef(
  projectRoot: string,
  ref: string,
  contractId: string,
): IntentContract | null {
  for (const dir of CONTROL_DIRS) {
    const text = readFileAtRef(
      projectRoot,
      ref,
      `${dir}/${CONTRACTS_SUBDIR}/${contractId}.yaml`,
    );
    if (text === null) continue;
    return assertValidIntentContract(parse(text));
  }
  return null;
}
