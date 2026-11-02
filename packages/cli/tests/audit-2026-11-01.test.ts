import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The 2026-11-01 cohesion audit's two B1 reproductions and its B2 output,
// end to end through the unified CLI. Published 1.9.0 exits 1 on both B1
// cases; 1.10.1 and 1.10.3 exit 0.

const CLI = join(import.meta.dirname, "..", "dist", "intent-guard.js");
const SKIP_REASON =
  "No .intent-guard/intent-contract.yaml (or legacy .conductor/intent-contract.yaml) found and require-frozen is off, so there was no contract to check against and nothing was checked.";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-audit-1101-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist not built - run `pnpm build` before tests");
});

describe("the 2026-11-01 audit's B1 reproductions block end to end", () => {
  it("blocks a dunder in an italic code span through extract, freeze and check", () => {
    const dir = project();
    expect(run(["init", "--project", dir]).code).toBe(0);
    expect(
      run(["extract", "--project", dir, "--text", "Add CSV export to the reports page. Never touch _`__init__`_."]).code,
    ).toBe(0);
    expect(run(["freeze", "--project", dir, "--approved-by", "auditor"]).code).toBe(0);
    const res = run(["check", "--project", dir, "--paths", "pkg/__init__.py"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Intent Guard gate: BLOCKED");
    expect(res.stderr).toContain("Drift soft_block (score 71/100)");
  });

  it("blocks a possessive in a hand-edited contract through drift --ci --contract", () => {
    // Through extract the possessive is rescued by a split item; a reviewed
    // or imported contract carries the rule as written.
    const dir = project();
    const contract = join(dir, "contract.json");
    writeFileSync(
      contract,
      JSON.stringify({
        contract_id: "ic-20261101-bbbbbb",
        version: "1.0.0",
        original_ask: "Add a theme toggle to the settings page.",
        in_scope: ["Theme toggle on the settings page"],
        out_of_scope: ["Do not change PaymentProcessor's retry logic"],
        constraints: [],
        acceptance_criteria: [{ id: "ac-1", description: "Toggle switches the theme", testable: true }],
        frozen_at: "2026-11-01T00:00:00.000Z",
        pivot_log: [],
      }),
      "utf8",
    );
    const res = run(["drift", "--project", dir, "--ci", "--contract", contract, "--paths", "src/PaymentProcessor.ts"]);
    expect(res.code).toBe(1);
    expect(res.stdout + res.stderr).toContain("soft_block");
    expect(res.stdout + res.stderr).not.toContain("file name only, not counted");
  });
});

describe("check with require-frozen off (2026-11-01 audit B2)", () => {
  it("prints a skipped line, never ok, when there is no contract, and keeps the JSON status ok with a skipReason", () => {
    const dir = project();
    const res = run(["check", "--project", dir, "--paths", "src/a.ts", "--no-require-frozen"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("Intent Guard gate: skipped, no contract to check against\n");

    // The status stays ok in this release: conductor 0.16.0 reads only ok
    // and blocked.
    const json = run(["check", "--project", dir, "--paths", "src/a.ts", "--no-require-frozen", "--json"]);
    expect(json.code).toBe(0);
    const out = JSON.parse(json.stdout);
    expect(out.status).toBe("ok");
    expect(out.skipReason).toBe(SKIP_REASON);
  });

  it("says nothing was checked in the report, text and JSON alike", () => {
    const dir = project();
    const text = run(["report", "--project", dir, "--paths", "src/a.ts", "--no-require-frozen"]);
    expect(text.code).toBe(0);
    const lines = text.stdout.split("\n");
    const at = lines.indexOf("Status: ok");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(`Skipped: ${SKIP_REASON}`);

    const json = JSON.parse(run(["report", "--project", dir, "--paths", "src/a.ts", "--no-require-frozen", "--json"]).stdout);
    expect(json.status).toBe("ok");
    expect(json.gate.skipReason).toBe(SKIP_REASON);
  });

  it("prints the same ok line as before when a contract is present", () => {
    const dir = project();
    run(["init", "--project", dir]);
    run(["extract", "--project", dir, "--text", "Add CSV export to the reports page. Do not change billing."]);
    run(["freeze", "--project", dir, "--approved-by", "auditor"]);
    for (const flags of [[], ["--no-require-frozen"]]) {
      const res = run(["check", "--project", dir, "--paths", "src/reports/export.ts", ...flags]);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe("✓ Intent Guard gate: ok\n");
      const json = JSON.parse(run(["check", "--project", dir, "--paths", "src/reports/export.ts", "--json", ...flags]).stdout);
      expect(json.status).toBe("ok");
      expect("skipReason" in json).toBe(false);
    }
    const report = run(["report", "--project", dir, "--paths", "src/reports/export.ts"]);
    expect(report.stdout).not.toContain("Skipped:");
  });
});
