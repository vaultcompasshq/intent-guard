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

/** The commit a rev names, or a TrustBaseError built by the caller's handler. */
function resolveCommit(projectRoot: string, rev: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Refuse the run unless the ref names a commit that is NOT the one being
 * judged.
 *
 * Two separate refusals, and the second is the one that matters.
 *
 * Resolving the ref at all is verified BEFORE any path is read, which is what
 * lets a path that is simply absent at the base be read as "no control input"
 * rather than as a broken setup. Without this order the two are the same
 * non-zero exit from git.
 *
 * The ref must then differ from HEAD, because a trust base that IS the head
 * commit puts the whole boundary back where it started: every control input
 * comes from the tree under judgment, no contract change can ever differ from
 * its own base, and the run reports "control inputs from: HEAD" while checking
 * the pull request against its own forgery. Nothing about that state is
 * visible in a green tick.
 *
 * It is not a hypothetical typo. A workflow author writing
 * `--trust-base ${{ github.sha }}` gets exactly this, because on a
 * pull_request event with the default actions/checkout that SHA is the merge
 * commit, which is HEAD. The comparison is on the RESOLVED COMMITS rather than
 * on the spelling, since the same commit reached through a branch name, a tag
 * or a raw SHA is the same hole.
 *
 * A branch with no commits ahead of its base resolves to the same commit and
 * is refused too. That is not a case this can tell apart from the
 * misconfiguration, and a pull request with nothing in it has nothing for the
 * gate to judge either way.
 */
export function assertTrustBaseResolvable(projectRoot: string, ref: string): void {
  let base: string;
  try {
    base = resolveCommit(projectRoot, ref);
  } catch (error) {
    throw new TrustBaseError(
      `intent-guard: cannot read control inputs from base ref "${ref}": ` +
        `${gitFirstLine(error)}. Nothing was checked. In CI, fetch the base ` +
        "branch (actions/checkout with fetch-depth: 0) before running the gate.",
    );
  }

  let head: string;
  try {
    head = resolveCommit(projectRoot, "HEAD");
  } catch (error) {
    // No head commit to compare against, so the one property that makes
    // pull-request mode mean anything cannot be established. Fail closed:
    // this is could-not-run, not a quiet downgrade to trusting the head.
    throw new TrustBaseError(
      `intent-guard: cannot resolve HEAD to compare against base ref "${ref}": ` +
        `${gitFirstLine(error)}. Pull-request mode needs both a base commit and ` +
        "a head commit. Nothing was checked.",
    );
  }

  if (base === head) {
    throw new TrustBaseError(
      `intent-guard: refusing "${ref}" as the trust base: it resolves to ${head}, ` +
        "the same commit as HEAD, so every control input would come from the tree " +
        "being judged and pull-request mode would be off while still reporting as " +
        "on. Pass the base branch (for example origin/main), not the head commit: " +
        "on a pull_request event github.sha is the merge commit, which is HEAD. " +
        "Nothing was checked.",
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
  /** Blob contents. For a symlink this is the LINK TARGET, not the file. */
  text: string;
  /**
   * The git file mode: 100644 a regular file, 100755 an executable one,
   * 120000 a symlink, 160000 a submodule, 040000 a directory.
   *
   * Carried because the CONTENT of a control input is not the whole of it.
   * Replacing the contract with a symlink whose target holds the base
   * contract's exact bytes changes nothing a content comparison can see, and
   * that is the first half of a two-step: land the link, then widen the link
   * target in a later pull request where the contract path never appears in
   * the diff at all.
   */
  mode: string;
  /** The git object type: blob, tree, or commit. */
  type: string;
}

/** True for the two modes that mean an ordinary file git will hand back. */
export function isRegularFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

/**
 * The tree entry for one path at a ref, or null when the ref has no such path.
 *
 * ls-tree rather than `git show` alone, because `git show ref:path` on a
 * symlink prints the link target and says nothing about the entry being a
 * link. The mode is the only place that fact lives.
 */
function treeEntry(
  projectRoot: string,
  ref: string,
  relativePath: string,
): { mode: string; type: string } | null {
  let out: string;
  try {
    out = execFileSync("git", ["ls-tree", ref, "--", `./${relativePath}`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const line = out.split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return null;
  const [mode, type] = line.split(/\s+/);
  if (!mode || !type) return null;
  return { mode, type };
}

/**
 * A control file at a ref, canonical state directory first.
 *
 * BOTH sides of the comparison go through this, base and head alike. An
 * earlier version read the head from the working tree with readFileSync,
 * which follows symlinks: the base side then held a link target string while
 * the head side held the linked file's contents, the two compared equal, and
 * a pull request that turned the contract into a symlink was reported as
 * having changed no control input at all. One reader for both sides is the
 * only way the two can be compared on equal terms.
 */
export function readControlFileAtRef(
  projectRoot: string,
  ref: string,
  filename: string,
): ControlFile | null {
  for (const dir of CONTROL_DIRS) {
    const path = `${dir}/${filename}`;
    const entry = treeEntry(projectRoot, ref, path);
    if (entry === null) continue;
    // A non-blob (a directory, a submodule) has no contents to read, and the
    // empty string keeps it distinguishable from a missing entry while the
    // mode carries what it actually is.
    const text = entry.type === "blob" ? (readFileAtRef(projectRoot, ref, path) ?? "") : "";
    return { path, text, mode: entry.mode, type: entry.type };
  }
  return null;
}

/**
 * The same control file at the head commit.
 *
 * The head TREE is what a pull-request run judges, so the head side is read
 * from `HEAD` rather than from the working tree. That also means an
 * uncommitted local edit to a control file is not mistaken for something the
 * pull request proposes.
 */
export function readControlFileAtHead(
  projectRoot: string,
  filename: string,
): ControlFile | null {
  return readControlFileAtRef(projectRoot, "HEAD", filename);
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

/** What kind of file the head made a control input into, when that changed. */
export type ControlShapeChange = "symlink" | "not-a-file" | "removed" | "mode";

/**
 * How the head changed the SHAPE of a control input, or null when it did not.
 *
 * Distinct from a content change because the shape is the part a content
 * comparison is blind to, and because each of these deserves its own sentence
 * in the report: "the contract is now a link" and "the contract now has the
 * execute bit" are not the same news.
 */
function shapeChange(
  base: ControlFile | null,
  head: ControlFile | null,
): ControlShapeChange | null {
  if (head === null) return base === null ? null : "removed";
  if (head.mode === "120000") return "symlink";
  if (!isRegularFileMode(head.mode)) return "not-a-file";
  if (base !== null && base.mode !== head.mode) return "mode";
  return null;
}

/** One line naming a shape change, for the proposals list. */
function shapeProposal(input: string, change: ControlShapeChange): string {
  switch (change) {
    case "symlink":
      return `${input} is a symlink at the head commit, not a regular file`;
    case "not-a-file":
      return `${input} is not a regular file at the head commit`;
    case "removed":
      return `${input} removed in this pull request`;
    case "mode":
      return `${input} file mode changed in this pull request`;
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

/**
 * Why a contract path that is not a regular file is refused, said once.
 *
 * Shared with the trusted-checkout read in contract-store, so the message a
 * user sees does not depend on which of the two paths noticed first.
 */
export function notAFileMessage(file: { path: string; mode?: string }): string {
  const kind = file.mode === "120000" ? "a symlink" : "not a regular file";
  return (
    `the contract path ${file.path} is ${kind}. Intent Guard will not follow a ` +
    "link to a contract: the file it points at is not the file anyone approved, " +
    "and a later edit to the link target would change the contract without the " +
    "contract path ever appearing in the diff. Replace it with a regular file."
  );
}

/** A contract at a ref, or null when that ref carries none. */
function contractAtRef(
  projectRoot: string,
  ref: string,
): {
  contract: IntentContract | null;
  file: ControlFile | null;
  error: Error | null;
} {
  const file = readControlFileAtRef(projectRoot, ref, DEFAULT_CONTRACT_FILE);
  if (file === null) return { contract: null, file: null, error: null };
  if (!isRegularFileMode(file.mode)) {
    // A link or a directory at the contract path is not a contract. Parsing a
    // link's target string yields the schema's "/ must be object", which tells
    // a reader nothing at all about the link, so the error is written here
    // instead and travels through the gate's existing contract-invalid reason.
    return { contract: null, file, error: new Error(notAFileMessage(file)) };
  }
  try {
    return {
      contract: assertValidIntentContract(parse(file.text)),
      file,
      error: null,
    };
  } catch (error) {
    return { contract: null, file, error: error as Error };
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
  /**
   * How the head changed the SHAPE of the contract file, or null. A link, a
   * directory, a deletion, or a mode-bit change. Refused by the gate when it
   * is enforcing, because none of these is a change to a contract: they are
   * changes to what the contract path even is.
   */
  contractShapeChange: ControlShapeChange | null;
  /** The same for config.yaml. Reported, never refused: config comes from base anyway. */
  configShapeChange: ControlShapeChange | null;
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
  const head = contractAtRef(projectRoot, "HEAD");

  const baseConfigFile = readControlFileAtRef(projectRoot, ref, CONFIG_FILE);
  const headConfigFile = readControlFileAtHead(projectRoot, CONFIG_FILE);
  const config =
    baseConfigFile === null
      ? { ...DEFAULT_CONDUCTOR_CONFIG }
      : parseConfigText(baseConfigFile.text, `${ref}:${baseConfigFile.path}`);

  const contractShapeChange = shapeChange(base.file, head.file);
  const configShapeChange = shapeChange(baseConfigFile, headConfigFile);

  // Content OR shape. A symlink whose target holds the base contract's exact
  // bytes has identical content by every measure available to a text
  // comparison, so without the shape half it reads as no change at all.
  const contractChanged =
    documentsDiffer(base.file?.text ?? null, head.file?.text ?? null) ||
    contractShapeChange !== null;
  const configChanged =
    documentsDiffer(
      baseConfigFile === null ? null : baseConfigFile.text,
      headConfigFile === null ? null : headConfigFile.text,
    ) || configShapeChange !== null;

  const proposals: string[] = [];
  if (contractChanged) proposals.push(CONTRACT_PROPOSAL_LINE);
  if (contractShapeChange !== null) {
    proposals.push(shapeProposal("contract", contractShapeChange));
  }
  if (configChanged) proposals.push(CONFIG_PROPOSAL_LINE);
  if (configShapeChange !== null) {
    proposals.push(shapeProposal("config", configShapeChange));
  }

  return {
    ref,
    contract: base.contract,
    contractError: base.error,
    config,
    contractChanged,
    configChanged,
    contractShapeChange,
    configShapeChange,
    headContractFound: head.file !== null,
    approvalDiffers: approvalOf(base.contract) !== approvalOf(head.contract),
    proposals,
  };
}

/** The refusal prefix for a control input whose file type or mode changed. */
export const CONTROL_INPUT_REASON_PREFIX = "Control input refused:";

/** The refusal, naming what the head made the contract path into. */
export function controlShapeReason(ref: string, change: ControlShapeChange): string {
  const path = `${STATE_DIR}/${DEFAULT_CONTRACT_FILE}`;
  switch (change) {
    case "symlink":
      return (
        `${CONTROL_INPUT_REASON_PREFIX} ${path} is a symlink at the head commit, ` +
        "not a regular file. A link makes the contract point at a file the base " +
        "ref never approved, and a later change to the link target would not show " +
        "as a contract change at all. Replace it with a regular file."
      );
    case "not-a-file":
      return (
        `${CONTROL_INPUT_REASON_PREFIX} ${path} is not a regular file at the head ` +
        "commit. Intent Guard reads its contract as a file. Replace it with one."
      );
    case "removed":
      return (
        `${CONTROL_INPUT_REASON_PREFIX} ${path} exists on "${ref}" but not at the ` +
        "head commit. Removing the approved contract in the same pull request it " +
        "is judged against is a change to the gate, not a change to the code."
      );
    case "mode":
      return (
        `${CONTROL_INPUT_REASON_PREFIX} the file mode of ${path} changed in this ` +
        `pull request. The contract's mode is part of what "${ref}" approved. ` +
        "Restore it, or land the change on the base branch first."
      );
  }
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
