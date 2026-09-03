import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSpecContract } from "../src/spec-bridge.js";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "conductor-spec-bridge-"));
}

const SPEC_BODY = [
  "# Online checks design",
  "",
  "## What this is",
  "",
  "Add an opt-in online registry check to the scanner.",
  "Escalate a low-severity typosquat finding when downloads confirm the asymmetry.",
  "Do not enable the online check by default.",
  "",
  "## Acceptance",
  "",
  "Verify a cached lookup is reused within the cache window.",
  "",
].join("\n");

const PLAN_BODY = [
  "# Online checks implementation plan",
  "",
  "## Goal",
  "",
  "Ship the registry client and wire it into the scan.",
  "",
  "## Tasks",
  "",
  "- [ ] Port the registry client into core",
  "- [ ] Add the local cache",
  "",
].join("\n");

/** Write a superpowers spec and optional plan, returning the project root. */
function superpowersProject(
  specName: string,
  planName?: string,
  bodies: { spec?: string; plan?: string } = {},
): string {
  const dir = tmpProject();
  mkdirSync(join(dir, "docs", "superpowers", "specs"), { recursive: true });
  mkdirSync(join(dir, "docs", "superpowers", "plans"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "superpowers", "specs", specName),
    bodies.spec ?? SPEC_BODY,
    "utf8",
  );
  if (planName) {
    writeFileSync(
      join(dir, "docs", "superpowers", "plans", planName),
      bodies.plan ?? PLAN_BODY,
      "utf8",
    );
  }
  return dir;
}

function setMtime(path: string, iso: string): void {
  const when = new Date(iso);
  utimesSync(path, when, when);
}

describe("spec bridge", () => {
  it("imports a Spec Kit spec directory into an unfrozen contract", () => {
    const dir = tmpProject();
    const specDir = join(dir, "specs", "photo-albums");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "spec.md"),
      [
        "# Photo albums",
        "- Build album grouping by date",
        "- Users can drag photos between albums",
        "- Albums must never be nested inside other albums",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(specDir, "plan.md"),
      "- Use local SQLite metadata storage\n- Avoid uploading images\n",
      "utf8",
    );
    writeFileSync(
      join(specDir, "tasks.md"),
      "- [ ] Create album list\n- [ ] Test drag and drop reorder\n",
      "utf8",
    );

    const imported = importSpecContract(dir, { format: "spec-kit" });

    expect(imported.format).toBe("spec-kit");
    expect(imported.files.map((file) => file.role)).toEqual([
      "requirements",
      "design",
      "tasks",
    ]);
    expect(imported.contract.frozen_by).toBeUndefined();
    expect(imported.contract.original_ask).toMatch(/Import spec-kit spec/);
    expect(imported.contract.in_scope).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/album grouping/i),
        expect.stringMatching(/drag photos/i),
      ]),
    );
    expect(imported.contract.out_of_scope).toEqual(
      expect.arrayContaining([expect.stringMatching(/never be nested/i)]),
    );
  });

  it("imports Kiro requirements/design/tasks from an explicit spec directory", () => {
    const dir = tmpProject();
    const specDir = join(dir, ".kiro", "specs", "billing-export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "requirements.md"),
      [
        "# Requirements",
        "WHEN a manager exports billing, THE SYSTEM SHALL include invoice totals.",
        "THE SYSTEM SHALL NOT expose customer payment tokens.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(specDir, "design.md"),
      "Use the existing export service and avoid new API routes.",
      "utf8",
    );
    writeFileSync(
      join(specDir, "tasks.md"),
      "- [ ] Add billing export column\n- [ ] Verify invoice totals\n",
      "utf8",
    );

    const imported = importSpecContract(dir, {
      format: "kiro",
      specDir: ".kiro/specs/billing-export",
    });

    expect(imported.format).toBe("kiro");
    expect(imported.files).toHaveLength(3);
    expect(imported.contract.acceptance_criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: expect.stringMatching(/invoice totals/i),
        }),
      ]),
    );
    expect(imported.contract.out_of_scope).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not expose customer payment tokens/i),
      ]),
    );
  });
});

describe("spec bridge: superpowers", () => {
  it("imports an explicit spec as requirements and plan as tasks", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
    );

    const imported = importSpecContract(dir, {
      format: "superpowers",
      specPath: "docs/superpowers/specs/2026-08-16-online-checks-design.md",
      planPath: "docs/superpowers/plans/2026-08-16-online-checks.md",
    });

    expect(imported.format).toBe("superpowers");
    expect(imported.specDir).toBe(join(dir, "docs", "superpowers"));
    expect(imported.files.map((file) => file.role)).toEqual(["requirements", "tasks"]);
    expect(imported.contract.frozen_by).toBeUndefined();
    expect(imported.contract.out_of_scope).toEqual(
      expect.arrayContaining([expect.stringMatching(/not enable the online check/i)]),
    );
  });

  it("imports the spec alone when no plan is given", () => {
    const dir = superpowersProject("2026-08-16-online-checks-design.md");

    const imported = importSpecContract(dir, {
      format: "superpowers",
      specPath: "docs/superpowers/specs/2026-08-16-online-checks-design.md",
    });

    expect(imported.files.map((file) => file.role)).toEqual(["requirements"]);
  });

  it("rejects a plan given without a spec", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
    );

    expect(() =>
      importSpecContract(dir, {
        format: "superpowers",
        planPath: "docs/superpowers/plans/2026-08-16-online-checks.md",
      }),
    ).toThrow(/plan/i);
  });

  it("auto-discovers the newest spec and its matching plan", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
    );
    writeFileSync(
      join(dir, "docs", "superpowers", "specs", "2026-09-01-newer-thing-design.md"),
      SPEC_BODY.replace("Online checks design", "Newer thing design"),
      "utf8",
    );
    writeFileSync(
      join(dir, "docs", "superpowers", "plans", "2026-09-01-newer-thing.md"),
      PLAN_BODY.replace("Online checks", "Newer thing"),
      "utf8",
    );
    // Explicit mtimes: creation order must not be what decides this.
    setMtime(
      join(dir, "docs", "superpowers", "specs", "2026-09-01-newer-thing-design.md"),
      "2026-09-01T00:00:00Z",
    );
    setMtime(
      join(dir, "docs", "superpowers", "specs", "2026-08-16-online-checks-design.md"),
      "2026-08-16T00:00:00Z",
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.files.map((file) => file.path)).toEqual([
      join(dir, "docs", "superpowers", "specs", "2026-09-01-newer-thing-design.md"),
      join(dir, "docs", "superpowers", "plans", "2026-09-01-newer-thing.md"),
    ]);
  });

  it("matches a plan for a spec named without the -design suffix", () => {
    const dir = superpowersProject("2026-09-02-export.md", "2026-09-02-export.md");

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.files.map((file) => file.role)).toEqual(["requirements", "tasks"]);
    expect(imported.files[1].path).toBe(
      join(dir, "docs", "superpowers", "plans", "2026-09-02-export.md"),
    );
  });

  it("imports the spec alone when no plan matches its stem", () => {
    const dir = superpowersProject("2026-09-02-export-design.md", "unrelated-plan.md");

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.files.map((file) => file.role)).toEqual(["requirements"]);
  });

  it("format auto still prefers spec-kit when both layouts exist", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
    );
    const specKitDir = join(dir, "specs", "photo-albums");
    mkdirSync(specKitDir, { recursive: true });
    writeFileSync(join(specKitDir, "spec.md"), "- Build album grouping by date\n", "utf8");

    expect(importSpecContract(dir, { format: "auto" }).format).toBe("spec-kit");
  });

  it("format auto picks superpowers when only that layout exists", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
    );

    expect(importSpecContract(dir, { format: "auto" }).format).toBe("superpowers");
  });

  it("attaches a change budget from a fenced yaml block in the plan", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "budget:",
          "  allowed_paths:",
          '    - "packages/core/src/online/**"',
          "  max_files: 12",
          "```",
          "",
        ].join("\n"),
      },
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.contract.budget).toEqual({
      allowed_paths: ["packages/core/src/online/**"],
      max_files: 12,
    });
  });

  it("leaves the budget undefined when the plan has no budget block", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [PLAN_BODY, "```yaml", "online: true", "```", ""].join("\n"),
      },
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.contract.budget).toBeUndefined();
  });

  it("rejects an invalid budget block and names the file", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "budget:",
          "  max_files: nope",
          "```",
          "",
        ].join("\n"),
      },
    );

    expect(() => importSpecContract(dir, { format: "superpowers" })).toThrow(
      /Invalid budget block in .*online-checks\.md/,
    );
  });

  it("rejects a budget fence with duplicate top-level keys", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "budget:",
          "  max_files: 3",
          "budget:",
          "  max_files: 4",
          "```",
          "",
        ].join("\n"),
      },
    );

    expect(() => importSpecContract(dir, { format: "superpowers" })).toThrow(
      /Invalid budget block in .*online-checks\.md/,
    );
  });

  it("rejects a budget fence with a duplicate nested key", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "budget:",
          "  max_files: 3",
          "  max_files: 4",
          "```",
          "",
        ].join("\n"),
      },
    );

    expect(() => importSpecContract(dir, { format: "superpowers" })).toThrow(
      /Invalid budget block in .*online-checks\.md/,
    );
  });

  it("rejects a budget fence indented with a tab", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "budget:",
          "\tmax_files: 3",
          "```",
          "",
        ].join("\n"),
      },
    );

    expect(() => importSpecContract(dir, { format: "superpowers" })).toThrow(
      /Invalid budget block in .*online-checks\.md/,
    );
  });

  it("ignores an unparseable yaml fence that is not a budget", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml",
          "online: true",
          "\tbad: indentation",
          "```",
          "",
        ].join("\n"),
      },
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.contract.budget).toBeUndefined();
  });

  it("reads a budget fence that carries an info string", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          PLAN_BODY,
          "```yaml title=budget",
          "budget:",
          "  max_files: 7",
          "```",
          "",
        ].join("\n"),
      },
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.contract.budget).toEqual({ max_files: 7 });
  });

  it("breaks an mtime tie on the filename, newest dated name first", () => {
    const dir = superpowersProject("2026-08-01-first-design.md");
    const specs = join(dir, "docs", "superpowers", "specs");
    writeFileSync(join(specs, "2026-09-02-latest-design.md"), SPEC_BODY, "utf8");
    writeFileSync(join(specs, "2026-08-20-middle-design.md"), SPEC_BODY, "utf8");
    // A fresh CI checkout stamps every file with the same mtime.
    setMtime(join(specs, "2026-08-01-first-design.md"), "2026-09-03T00:00:00Z");
    setMtime(join(specs, "2026-08-20-middle-design.md"), "2026-09-03T00:00:00Z");
    setMtime(join(specs, "2026-09-02-latest-design.md"), "2026-09-03T00:00:00Z");

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(imported.files[0].path).toBe(join(specs, "2026-09-02-latest-design.md"));
  });

  it("keeps fenced code out of the drafted contract", () => {
    const dir = superpowersProject(
      "2026-08-16-online-checks-design.md",
      "2026-08-16-online-checks.md",
      {
        plan: [
          "# Online checks implementation plan",
          "",
          "## Tasks",
          "",
          "- [ ] Port the registry client into core",
          "",
          "```ts",
          "test('returns the parsed body on a 200', async () => {",
          "  expect(await fetchJson(url)).toEqual({ ok: true });",
          "});",
          "```",
          "",
          "Verify the cache is reused within the window.",
          "",
        ].join("\n"),
      },
    );

    const imported = importSpecContract(dir, { format: "superpowers" });

    expect(JSON.stringify(imported.contract)).not.toContain("returns the parsed body");
    expect(JSON.stringify(imported.contract)).not.toContain("fetchJson");
    // Prose on either side of the fence still lands.
    expect(imported.contract.acceptance_criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: expect.stringMatching(/cache is reused/i),
        }),
      ]),
    );
  });
});
