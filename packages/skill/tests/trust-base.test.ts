import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const DIST = join(import.meta.dirname, "..", "dist");
const execFileAsync = promisify(execFile);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cli: string, args: string[], cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [join(DIST, cli), ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr ?? "") };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

beforeAll(() => {
  if (!existsSync(join(DIST, "check-cli.js"))) {
    throw new Error("dist not built - run `pnpm build` before tests");
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function writeAt(dir: string, relative: string, body: string): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

/**
 * The approved contract on the base branch. Narrow on purpose: one in-scope
 * item, one out-of-scope item that a path can trip, one critical constraint,
 * and a protected path. Every attack below is an attempt to widen one of them
 * from inside the pull request.
 */
const BASE_CONTRACT = `contract_id: ic-20260905-aaaaaa
version: 1.0.0
original_ask: Update the readme usage docs and nothing else.
in_scope:
  - Update the README usage documentation
out_of_scope:
  - Changes to the payment module
constraints:
  - source: user-stated
    rule: Do not touch the payment module
    priority: critical
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-05T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  protected_paths:
    - "**/payment/**"
`;

/** The forgery: wide open, self-approved, protected paths gone. */
const FORGED_CONTRACT = `contract_id: ic-20260905-aaaaaa
version: 1.0.0
original_ask: Refactor the payment module and update the docs.
in_scope:
  - Update the README usage documentation
  - Refactor the payment module end to end
out_of_scope: []
constraints: []
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-06T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: the-pull-request-itself
  approved_at: "2026-09-06T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
budget:
  allowed_paths:
    - "**"
`;

/**
 * The same widening WITHOUT touching the approval block. This is the honest
 * case: somebody proposes a broader contract and has not re-frozen it.
 */
const WIDENED_CONTRACT = FORGED_CONTRACT.replace(
  /approval:\n(?:  .*\n)+/,
  `approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
`,
);

/**
 * A contract whose only lever is a MEDIUM-priority constraint.
 *
 * The config attack needs a drift signal with no score floor under it. A
 * scope-creep hit and a high or critical constraint each floor the overall
 * score at a band taken from the config itself, so raising that band raises
 * the score with it and the gate blocks anyway. A medium constraint has no
 * floor, so its weighted score of 12 is entirely at the mercy of where the
 * bands sit. That is the config lever that is real, and it is the one these
 * tests use.
 *
 * The rule is a one-word item so coverage matching still counts it strong
 * (one shared token never blocks unless the item is that one word). A
 * multi-word "payment module" phrase against src/payment/charge.ts is only
 * partial and would score 0, which would make the band attack invisible.
 */
const MEDIUM_CONSTRAINT_CONTRACT = `contract_id: ic-20260905-bbbbbb
version: 1.0.0
original_ask: Update the readme usage docs and nothing else.
in_scope:
  - Update the README usage documentation
out_of_scope: []
constraints:
  - source: user-stated
    rule: Never payment
    priority: medium
acceptance_criteria:
  - id: ac-1
    description: One usage example is documented in the README
    testable: true
frozen_at: "2026-09-05T00:00:00.000Z"
frozen_by: user
approval:
  approved_by: alice
  approved_at: "2026-09-05T00:00:00.000Z"
  method: explicit-flag
pivot_log: []
`;

/** The project's own strict bands, committed on the base branch. */
const STRICT_BASE_CONFIG = `version: 1.0.0
drift:
  mode: handoff
  thresholds:
    info: 1
    warn: 2
    soft_block: 3
    hard_block: 4
  hard_block_on_critical_constraints: true
`;

/**
 * The bands relaxed back to the shipped defaults. Every value is legal, which
 * is exactly why the base-versus-head rule and not a schema floor is what
 * catches this one.
 */
const RELAXED_HEAD_CONFIG = `version: 1.0.0
drift:
  mode: handoff
  thresholds:
    info: 26
    warn: 51
    soft_block: 71
    hard_block: 86
  hard_block_on_critical_constraints: false
`;

interface RepoSpec {
  /** Files committed on main before the branch forks. */
  base: Record<string, string>;
  /** Files written and committed on the feature branch. */
  head: Record<string, string>;
}

function repo(spec: RepoSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-trust-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeAt(dir, "README.md", "# Project\n");
  for (const [relative, body] of Object.entries(spec.base)) writeAt(dir, relative, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  for (const [relative, body] of Object.entries(spec.head)) writeAt(dir, relative, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "work"]);
  return dir;
}

const CONTRACT = ".intent-guard/intent-contract.yaml";
const CONFIG = ".intent-guard/config.yaml";
const OUT_OF_SCOPE_FILE = "src/payment/charge.ts";

/**
 * A forged pull request, and a trust base that is the commit being judged.
 *
 * The realistic way in is a workflow author writing `${{ github.sha }}`, which
 * after actions/checkout on a pull request is the MERGE COMMIT, so the flag is
 * accepted, the report says pull-request mode is on, and the boundary is off.
 * A run in that state must refuse rather than pass with a green tick.
 */
function forgedRepoWithAlias(): string {
  const dir = repo({
    base: { [CONTRACT]: BASE_CONTRACT },
    head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
  });
  git(dir, ["branch", "ci-head"]);
  return dir;
}

describe("intent-guard check --trust-base refuses the head as its own base", {
  timeout: 60_000,
}, () => {
  it("refuses --trust-base HEAD with exit 2 and one line", async () => {
    const dir = forgedRepoWithAlias();

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "HEAD",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toContain("HEAD");
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("refuses a ref that resolves to the head commit under another name", async () => {
    const dir = forgedRepoWithAlias();

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "ci-head",
      "--json",
    ]);

    // The name is different and it resolves cleanly, so only comparing the
    // resolved commits catches this one.
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("ci-head");
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("still accepts a base ref that is a different commit", async () => {
    const dir = forgedRepoWithAlias();

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).trustBase.selfApproval).toBe(true);
  });
});

/**
 * Two different commits can hold the same tree, and then the commit check
 * passes while the boundary is still off.
 *
 * The realistic shape is not contrived. What GitHub publishes as
 * refs/pull/N/merge is a merge commit whose tree, when the base has not moved
 * since the fork, is byte for byte the head branch's tree. actions/checkout
 * leaves that commit checked out detached, so `--trust-base` pointed at
 * `github.event.pull_request.head.sha` names a DIFFERENT commit carrying an
 * IDENTICAL tree: every control input still comes from the tree under
 * judgment, and there is nothing for base-versus-head to compare.
 */
describe("intent-guard check --trust-base refuses an identical tree", {
  timeout: 60_000,
}, () => {
  function forgedBranch(): string {
    return repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });
  }

  function rev(dir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  }

  it("refuses a different commit that carries the head's tree", async () => {
    const dir = forgedBranch();
    const tree = rev(dir, ["rev-parse", "HEAD^{tree}"]);
    const twin = rev(dir, ["commit-tree", tree, "-p", "main", "-m", "same tree"]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", twin,
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toContain(twin);
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("refuses the merge-ref shape a pull-request checkout produces", async () => {
    const dir = forgedBranch();
    const main = rev(dir, ["rev-parse", "main"]);
    const feature = rev(dir, ["rev-parse", "feature"]);
    const tree = rev(dir, ["rev-parse", "feature^{tree}"]);
    // commit-tree with both parents and the head's tree: refs/pull/N/merge.
    const merge = rev(dir, ["commit-tree", tree, "-p", main, "-p", feature, "-m", "merge"]);
    git(dir, ["checkout", "--detach", merge]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", feature,
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain(feature);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("accepts a base whose only difference is a file no control input names", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    // The trees differ by one ordinary file, which is the whole normal case.
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).trustBase.proposals).toEqual([]);
  });

  it("still blocks a pull request that merged the base into itself", async () => {
    const dir = forgedBranch();
    git(dir, ["checkout", "main"]);
    writeAt(dir, "docs/unrelated.md", "moved on\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main moves on"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["merge", "--no-edit", "main"]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    // Merging the base in changes the head's tree, so the trees differ and the
    // run proceeds to judge the forgery. This is the case the tree check must
    // NOT swallow.
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).trustBase.selfApproval).toBe(true);
  });

  it("names an unresolvable ref in plain words, without git plumbing", async () => {
    const dir = forgedBranch();

    const res = await run("check-cli.js", [
      "--project", dir,
      "--trust-base", "origin/nope",
      "--paths", "docs/usage.md",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("origin/nope");
    // The --quiet flag suppresses git's own stderr, so the fallback used to
    // print the exception text and hand the user a command line to run.
    expect(res.stderr).not.toContain("Command failed");
    expect(res.stderr).not.toContain("rev-parse");
  });
});

/**
 * The control input is a FILE, and what kind of file it is counts.
 *
 * Replacing the contract with a symlink whose target holds the base contract's
 * exact bytes changes nothing a content comparison can see, and git records it
 * as a type change. Left alone it is the first half of a two-step: land the
 * link, then widen the link target in a later pull request, where the contract
 * path itself never appears in the diff.
 */
describe("intent-guard check --trust-base sees the file's type", { timeout: 60_000 }, () => {
  function repoWithSymlinkedContract(base: Record<string, string>): string {
    const dir = repo({ base, head: { "docs/usage.md": "usage\n" } });
    writeAt(dir, "docs/contract.yaml", BASE_CONTRACT);
    unlinkSync(join(dir, CONTRACT));
    symlinkSync("../docs/contract.yaml", join(dir, CONTRACT));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "make the contract a link"]);
    return dir;
  }

  it("reports a contract turned into a symlink even when the bytes match", async () => {
    const dir = repoWithSymlinkedContract({ [CONTRACT]: BASE_CONTRACT });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractChanged).toBe(true);
    expect(out.trustBase.contractShapeChange).toBe("symlink");
    expect(out.trustBase.proposals.join(" ")).toContain("symlink");
  });

  it("reports a gitlink at the contract path as not a regular file", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });
    const someCommit = execFileSync("git", ["rev-parse", "main"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    // A submodule entry, mode 160000, sitting where the contract belongs.
    git(dir, ["rm", "-q", "--cached", "--", CONTRACT]);
    git(dir, ["update-index", "--add", "--cacheinfo", `160000,${someCommit},${CONTRACT}`]);
    git(dir, ["commit", "-m", "gitlink at the contract path"]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractShapeChange).toBe("not-a-file");
    expect(out.trustBase.proposals.join(" ")).toContain("not a regular file");
    expect(out.reasons.join(" ")).toContain("Control input refused:");
  });

  it("refuses the symlinked contract when the gate is enforcing", async () => {
    const dir = repoWithSymlinkedContract({ [CONTRACT]: BASE_CONTRACT });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const refusals = (JSON.parse(res.stdout).reasons as string[]).filter((reason) =>
      reason.startsWith("Control input refused:"),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("symlink");
  });

  it("reports but does not refuse the symlink with enforcement off", async () => {
    const dir = repoWithSymlinkedContract({ [CONTRACT]: BASE_CONTRACT });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--no-require-frozen",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.proposals.join(" ")).toContain("symlink");
    expect(out.reasons.join(" ")).not.toContain("Control input refused");
  });

  it("reports a contract whose mode bits changed and nothing else", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });
    git(dir, ["update-index", "--chmod=+x", CONTRACT]);
    git(dir, ["commit", "-m", "chmod the contract"]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractChanged).toBe(true);
    expect(out.trustBase.contractShapeChange).toBe("mode");
    expect(out.trustBase.proposals.join(" ")).toContain("mode");
  });

  it("refuses a pull request that deletes the approved contract", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });
    git(dir, ["rm", "-q", "--", CONTRACT]);
    git(dir, ["commit", "-m", "drop the contract"]);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractShapeChange).toBe("removed");
    expect(out.trustBase.proposals.join(" ")).toContain("removed");
    expect(out.reasons.join(" ")).toContain("Control input refused:");
  });
});

/**
 * The second half of the two-step, on the TRUSTED path with no flag at all.
 *
 * With the link already committed on both sides, the widened contract lives in
 * docs/contract.yaml and the contract path never appears in the diff. Nothing
 * about pull-request mode helps here, so the read itself has to refuse to
 * follow the link.
 */
/**
 * The link does not have to be on the contract file.
 *
 * Refusing a symlinked contract while following a symlinked STATE DIRECTORY
 * leaves the same two-step open one level up: link `.intent-guard` at a
 * directory the pull request added, and every read underneath it lands
 * somewhere nobody approved, with the contract path itself looking like an
 * ordinary file the whole way.
 */
describe("the state directory is a directory, not a link", { timeout: 60_000 }, () => {
  function repoWithLinkedStateDir(): string {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [OUT_OF_SCOPE_FILE]: "export const charge = () => 999;\n" },
    });
    git(dir, ["rm", "-r", "-q", "--", ".intent-guard"]);
    writeAt(dir, "real-state/intent-contract.yaml", FORGED_CONTRACT);
    symlinkSync("real-state", join(dir, ".intent-guard"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "link the state directory"]);
    return dir;
  }

  it("refuses a symlinked state directory on the trusted path, with no flag", async () => {
    const dir = repoWithLinkedStateDir();

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);

    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("symlink");
    expect(`${res.stdout}${res.stderr}`).toContain(".intent-guard");
  });

  it("does not read the forged contract the link points at", async () => {
    const dir = repoWithLinkedStateDir();

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);

    // The forgery widens scope to everything; obeying it is what "ok" here
    // would have meant.
    expect(res.stdout).not.toContain('"status":"ok"');
  });
});

describe("the trusted checkout refuses a symlinked contract", { timeout: 60_000 }, () => {
  function repoLinkedOnBothSides(target: string): string {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-twostep-"));
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "tester@example.com"]);
    git(dir, ["config", "user.name", "tester"]);
    writeAt(dir, "README.md", "# Project\n");
    writeAt(dir, OUT_OF_SCOPE_FILE, "export const charge = () => 0;\n");
    writeAt(dir, "docs/contract.yaml", BASE_CONTRACT);
    mkdirSync(join(dir, ".intent-guard"), { recursive: true });
    symlinkSync("../docs/contract.yaml", join(dir, CONTRACT));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base already carries the link"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeAt(dir, "docs/contract.yaml", target);
    writeAt(dir, OUT_OF_SCOPE_FILE, "export const charge = () => 999;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "widen through the link target"]);
    return dir;
  }

  it("blocks with a message naming the symlink, with no flag", async () => {
    const dir = repoLinkedOnBothSides(FORGED_CONTRACT);

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);

    expect(res.code).toBe(1);
    const reasons = (JSON.parse(res.stdout).reasons as string[]).join(" ");
    expect(reasons).toContain("symlink");
    // The old failure mode was an unintelligible schema error about "/ must be
    // object", which told a reader nothing about the link.
    expect(reasons).not.toContain("must be object");
  });

  it("blocks in pull-request mode too, with the same readable message", async () => {
    const dir = repoLinkedOnBothSides(FORGED_CONTRACT);

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const reasons = (JSON.parse(res.stdout).reasons as string[]).join(" ");
    expect(reasons).toContain("symlink");
    expect(reasons).not.toContain("must be object");
  });
});

describe("intent-guard check --trust-base", { timeout: 60_000 }, () => {
  it("refuses a contract rewrite that grants itself a new approval", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("blocked");
    expect(out.trustBase.selfApproval).toBe(true);
    const selfApproval = (out.reasons as string[]).filter((reason) =>
      reason.startsWith("Self-approval refused:"),
    );
    expect(selfApproval).toHaveLength(1);
    expect(selfApproval[0]).toContain("main");
    // The head contract deleted protected_paths. The base contract still has
    // it, and the base contract is what judged this change.
    expect(JSON.stringify(out.budget)).toContain(OUT_OF_SCOPE_FILE);
    expect(out.budget.action).toBe("hard_block");
  });

  it("names the contract change as a proposal rather than obeying it", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.contractChanged).toBe(true);
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("ignores a head-side config that relaxes the drift bands, and says so", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    // The base bands hard-block at 4 and the change scores 12. The head bands
    // would have called the same 12 "proceed".
    expect(JSON.parse(res.stdout).drift.action).toBe("hard_block");
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.configChanged).toBe(true);
    expect(out.trustBase.proposals).toContain("config changed in this pull request");
  });

  it("obeys the relaxed head config when the flag is absent, which is the hole", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", ["--project", dir, "--base", "main", "--json"]);

    // Not a wish: this asserts the pre-1.4.0 behaviour is still what a
    // trusted local checkout gets, so the fixtures above are known to be
    // discriminating rather than passing for some other reason.
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).drift.action).toBe("proceed");
  });

  it("reports a widened contract as a proposal and judges against the base scope", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
    // The approval block is untouched, so this is a proposal and not a forgery.
    expect(out.trustBase.selfApproval).toBe(false);
    expect(out.reasons.join(" ")).not.toContain("Self-approval refused");
    // Judged against the base contract, so the widening does not take effect.
    expect(out.drift.findings.join(" ")).toContain("Changes to the payment module");
  });

  it("passes a widening whose changes stay inside the base scope", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("does not raise self-approval when the gate is not enforcing a frozen contract", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--no-require-frozen",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.trustBase.selfApproval).toBe(false);
    expect(out.reasons.join(" ")).not.toContain("Self-approval refused");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("judges normally and proposes nothing when no control input changed", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.trustBase.proposals).toEqual([]);
    expect(out.trustBase.contractChanged).toBe(false);
    expect(out.trustBase.configChanged).toBe(false);
  });

  it("reports no contract when the base has none, and treats the head's as a proposal", async () => {
    const dir = repo({
      base: {},
      head: { [CONTRACT]: FORGED_CONTRACT, [OUT_OF_SCOPE_FILE]: "export const x = 1;\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.contractFound).toBe(false);
    expect(out.reasons[0]).toContain("No .intent-guard/intent-contract.yaml found");
    expect(out.trustBase.proposals).toContain("contract changed in this pull request");
    // First adoption is not an attack, so it is not named as self-approval.
    expect(out.trustBase.selfApproval).toBe(false);
  });

  it("fails closed with exit 2 when the trust base ref cannot be resolved", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--trust-base", "no-such-ref",
      "--paths", "docs/usage.md",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no-such-ref");
    expect(res.stdout).not.toContain('"status":"ok"');
  });

  it("fails closed with exit 2 on a base config the schema refuses", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT, [CONFIG]: "drift:\n  thresholds:\n    warn: 900\n" },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("main:.intent-guard/config.yaml");
  });

  it("treats --trust-base with no ref value as a usage error", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });
    const res = await run("check-cli.js", ["--project", dir, "--trust-base"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Usage: intent-guard check");
  });

  it("prints the proposal on a human-readable run too", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: WIDENED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
    ]);

    expect(res.code).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("contract changed in this pull request");
  });
});

describe("intent-guard report --trust-base", { timeout: 60_000 }, () => {
  it("summarises the base contract, not the head's", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONTRACT]: FORGED_CONTRACT, "docs/usage.md": "usage\n" },
    });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
      "--json",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.contract.approved_by).toBe("alice");
    expect(out.contract.out_of_scope).toContain("Changes to the payment module");
    expect(out.gate.trustBase.proposals).toContain("contract changed in this pull request");
  });

  it("prints the proposal in the markdown report", async () => {
    const dir = repo({
      base: { [CONTRACT]: BASE_CONTRACT },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--base", "main",
      "--trust-base", "main",
    ]);

    expect(res.stdout).toContain("config changed in this pull request");
    expect(res.stdout).toContain("Pull-request mode");
  });

  it("fails closed with exit 2 when the trust base ref cannot be resolved", async () => {
    const dir = repo({ base: { [CONTRACT]: BASE_CONTRACT }, head: { "docs/usage.md": "x\n" } });

    const res = await run("report-cli.js", [
      "--project", dir,
      "--trust-base", "ghost-branch",
      "--paths", "docs/usage.md",
      "--json",
    ]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("ghost-branch");
  });
});

describe("intent-guard drift --trust-base", { timeout: 60_000 }, () => {
  it("scores with the base ref's thresholds, not the head's", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const withTrust = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--trust-base", "main",
      "--paths", OUT_OF_SCOPE_FILE,
    ]);
    expect(JSON.parse(withTrust.stdout).action).toBe("hard_block");

    const withoutTrust = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--paths", OUT_OF_SCOPE_FILE,
    ]);
    expect(JSON.parse(withoutTrust.stdout).action).toBe("proceed");
  });
});

// A MISTYPED FLAG MUST NOT QUIETLY BECOME A WEAKER RUN.
//
// The argv loops in these CLIs are an if/else-if chain with no trailing else,
// so an unrecognised argument was dropped without a word. That is a fail-OPEN,
// and the pair of assertions above measures exactly what it costs:
// `--trust-base` gives hard_block, no `--trust-base` gives proceed. So
// `--trust-bse` scored the head's own relaxed thresholds and reported proceed,
// while the workflow that asked for pull-request mode looked like it had it.
//
// Same family as the vault-guard defect of 2026-09-16, in the opposite
// direction: that one failed closed and shouted, this one failed open and said
// nothing. `--base` and `--trust-base` already refuse a MISSING value, so the
// parser had a refusal path and simply never reached it for an unknown name.
describe("mistyped flags are refused, not ignored", { timeout: 60_000 }, () => {
  it("refuses a misspelled --trust-base instead of silently dropping the mode", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const typo = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--trust-bse", "main",
      "--paths", OUT_OF_SCOPE_FILE,
    ]);

    expect(typo.code).not.toBe(0);
    expect(typo.stderr).toContain("--trust-bse");
    // The tell that this is the fail-open rather than an unrelated error: the
    // old behaviour produced a clean, successful, WEAKER verdict.
    expect(typo.stdout).not.toContain("proceed");
  });

  it("refuses an unknown flag on check as well", async () => {
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { "docs/usage.md": "usage\n" },
    });

    const res = await run("check-cli.js", ["--project", dir, "--truts-base", "main"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("--truts-base");
  });

  it("still accepts every documented flag", async () => {
    // The refusal must not catch a real flag. If this goes red the guard is too
    // broad, which breaks consumers rather than protecting them.
    const dir = repo({
      base: { [CONTRACT]: MEDIUM_CONSTRAINT_CONTRACT, [CONFIG]: STRICT_BASE_CONFIG },
      head: { [CONFIG]: RELAXED_HEAD_CONFIG, "docs/usage.md": "usage\n" },
    });

    const ok = await run("drift-cli.js", [
      "--project", dir,
      "--contract", join(dir, CONTRACT),
      "--trust-base", "main",
      "--paths", OUT_OF_SCOPE_FILE,
    ]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).action).toBe("hard_block");
  });
});
