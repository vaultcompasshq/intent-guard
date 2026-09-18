import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-unknown-flags-"));
}

/** A directory the hook installer will accept as a repository. */
function tmpGitProject(): string {
  const dir = tmpProject();
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

function hookPath(dir: string): string {
  return join(dir, ".git", "hooks", "pre-commit");
}

beforeAll(() => {
  if (!existsSync(join(DIST, "hook-cli.js"))) {
    throw new Error("dist not built — run `pnpm build` before tests");
  }
});

// THE ONE IN THIS FILE THAT IS NOT COSMETIC.
//
// `hook install --with-vault-guard` pairs the generated pre-commit hook with a
// vault-guard secret scan. Mistyped, the flag was dropped without a word and
// the install still SUCCEEDED, exit 0, printing `installed: true`. What landed
// was a hook with no secrets scanning in it, and the user had every reason to
// believe they had just installed secrets scanning. A silent security
// downgrade, not a UX wart: the failure mode is a commit full of credentials
// sailing through a gate the user thinks is armed.
//
// The two assertions that matter are the pair. The first measures what the
// flag is worth, so the second is a refusal of something with a cost rather
// than of a harmless typo.
describe("hook install refuses a mistyped --with-vault-guard", { timeout: 60_000 }, () => {
  it("installs the vault-guard scan when the flag is spelled correctly", async () => {
    const dir = tmpGitProject();
    const res = await run("hook-cli.js", ["install", "--project", dir, "--with-vault-guard"]);

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).withVaultGuard).toBe(true);
    expect(readFileSync(hookPath(dir), "utf8")).toContain("vault-guard scan --staged");
  });

  it("refuses the typo instead of installing a hook without the scan", async () => {
    const dir = tmpGitProject();
    const res = await run("hook-cli.js", ["install", "--project", dir, "--with-vault-gaurd"]);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("--with-vault-gaurd");
    // The tell that this is the silent downgrade rather than an unrelated
    // error: the old behaviour installed a hook and called it a success.
    expect(res.stdout).not.toContain('"installed":true');
    expect(existsSync(hookPath(dir))).toBe(false);
  });
});

// The commands that take a word before their flags. A refusal that rejects
// unknown FLAGS must still accept these, or it breaks the two commands whose
// documented invocation is `hook install ...` and `rules audit ...`.
describe("subcommand words still work", { timeout: 60_000 }, () => {
  it("hook install installs, with and without the subcommand word", async () => {
    const withWord = tmpGitProject();
    const withoutWord = tmpGitProject();

    const a = await run("hook-cli.js", ["install", "--project", withWord]);
    const b = await run("hook-cli.js", ["--project", withoutWord]);

    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout).installed).toBe(true);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.stdout).installed).toBe(true);
  });

  it("rules audit runs, and an unknown flag after it is refused", async () => {
    const dir = tmpProject();

    const ok = await run("rules-cli.js", ["audit", "--project", dir, "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).status).toBeDefined();

    const typo = await run("rules-cli.js", ["audit", "--project", dir, "--jsno"]);
    expect(typo.code).not.toBe(0);
    expect(typo.stderr).toContain("--jsno");
  });
});

// coach is the one command in this family that is DELIBERATELY left alone.
// Everything after the command is the prompt text being scored, so there is no
// flag position to guard past the first token, and a refusal here would reject
// the ordinary case of scoring a sentence.
describe("coach still takes free text", { timeout: 60_000 }, () => {
  it("scores a bare sentence", async () => {
    const res = await run("coach-cli.js", ["Add CSV export. No new API endpoints."]);
    expect(res.code).toBe(0);
    expect(typeof JSON.parse(res.stdout).score).toBe("number");
  });

  it("scores text that merely looks like a flag", async () => {
    const res = await run("coach-cli.js", ["--with-vault-gaurd is not a flag here"]);
    expect(res.code).toBe(0);
    expect(typeof JSON.parse(res.stdout).score).toBe("number");
  });
});

// The rest of the family. Every one of these was an if/else-if chain with no
// trailing else, so a mistyped flag ran the command with that flag's effect
// missing and said nothing. None of them can change a CI verdict the way
// check/report/drift can, and none of them drops a security control the way
// hook does, so these are UX — but the parser shape is identical and so is the
// fix.
const FLAG_ONLY: Array<{ cli: string; prefix: string[] }> = [
  { cli: "brief-cli.js", prefix: [] },
  { cli: "correct-cli.js", prefix: [] },
  { cli: "doctor-cli.js", prefix: [] },
  { cli: "extract-cli.js", prefix: ["--text", "add csv export"] },
  { cli: "freeze-cli.js", prefix: [] },
  { cli: "import-spec-cli.js", prefix: [] },
  { cli: "index-cli.js", prefix: [] },
  { cli: "init-cli.js", prefix: [] },
  { cli: "pivot-cli.js", prefix: ["--change", "scope moved"] },
  { cli: "resume-cli.js", prefix: [] },
];

describe("every flags-only CLI refuses an unknown option", { timeout: 60_000 }, () => {
  for (const { cli, prefix } of FLAG_ONLY) {
    it(`${cli} names the offending argument and exits non-zero`, async () => {
      const dir = tmpProject();
      const res = await run(cli, ["--project", dir, ...prefix, "--not-a-real-flag"]);

      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain("--not-a-real-flag");
    });

    it(`${cli} refuses a bare word too`, async () => {
      const dir = tmpProject();
      const res = await run(cli, ["--project", dir, ...prefix, "somefile.ts"]);

      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain("somefile.ts");
    });
  }
});

// The refusal must not catch a real flag. If this goes red the guard is too
// broad, which breaks consumers rather than protecting them.
describe("documented flags still work", { timeout: 60_000 }, () => {
  it("init --human, index --json, and doctor --json all run", async () => {
    const dir = tmpProject();

    const init = await run("init-cli.js", ["--project", dir, "--human"]);
    expect(init.code).toBe(0);

    const index = await run("index-cli.js", ["--project", dir, "--json"]);
    expect(index.code).toBe(0);
    expect(JSON.parse(index.stdout).index_markdown).toBeDefined();

    const doctor = await run("doctor-cli.js", ["--project", dir, "--json"]);
    expect(JSON.parse(doctor.stdout).findings.length).toBeGreaterThan(0);
  });

  it("extract --dry-run then freeze --approved-by still completes", async () => {
    const dir = tmpProject();

    const extract = await run("extract-cli.js", [
      "--project",
      dir,
      "--text",
      "Add CSV export. No new API endpoints.",
    ]);
    expect(extract.code).toBe(0);

    const freeze = await run("freeze-cli.js", [
      "--project",
      dir,
      "--approved-by",
      "tester",
      "--json",
    ]);
    expect(freeze.code).toBe(0);
    expect(JSON.parse(freeze.stdout).frozen).toBe(true);
  });
});
