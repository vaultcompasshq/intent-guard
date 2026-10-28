import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import { dedupeConstraints, dedupeRules, extractConstraintsFromMarkdown } from "../src/constraints.js";
import { ORIGINAL_ASK_MAX, draftContract, draftContractDetailed } from "../src/extract.js";
import { scoreDrift } from "../src/drift.js";
import { prohibitedSubject } from "../src/tokenize.js";
import { suggestPathBudgets } from "../src/path-suggestions.js";
import { NO_LABELLED_SCOPE_ITEM, importSpecContract, selectLabelledSections } from "../src/spec-bridge.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("original_ask keeps the whole ask", () => {
  it("keeps every sentence of the ask, not only the first", () => {
    const ask =
      "Add CSV export for the fund table. Put the button in the toolbar.\nDo not add PDF export.";
    const draft = draftContract({ userText: ask });
    expect(draft.original_ask).toBe(
      "Add CSV export for the fund table. Put the button in the toolbar. Do not add PDF export.",
    );
  });

  it("truncates a long ask at a sentence boundary with an ellipsis, never mid-sentence", () => {
    const sentence = "Add one more export column to the fund performance table for the reviewers.";
    const ask = Array.from({ length: 12 }, () => sentence).join(" ");
    const draft = draftContract({ userText: ask });
    expect(draft.original_ask.length).toBeLessThanOrEqual(ORIGINAL_ASK_MAX);
    expect(draft.original_ask.endsWith(`${sentence} ...`)).toBe(true);
    expect(validateIntentContract(draft).valid).toBe(true);
  });

  it("cuts a single over-long sentence at a word boundary", () => {
    const ask = `Add ${"the export column ".repeat(40)}now`;
    const draft = draftContract({ userText: ask });
    expect(draft.original_ask.length).toBeLessThanOrEqual(ORIGINAL_ASK_MAX);
    expect(draft.original_ask.endsWith(" ...")).toBe(true);
    // The kept text is a run of whole words of the ask.
    expect(ask.startsWith(`${draft.original_ask.slice(0, -4)} `)).toBe(true);
  });

  it("keeps the import-spec ask to its header sentence, not the spec body", () => {
    const dir = mkdtempSync(join(tmpdir(), "ig-ask-"));
    const specDir = join(dir, ".kiro", "specs", "export");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "requirements.md"),
      "# Requirements\n\n- Add the CSV export button\n\n## Out of scope\n\n- PDF rendering\n",
      "utf8",
    );
    const { contract } = importSpecContract(dir, { format: "kiro", specDir: ".kiro/specs/export" });
    expect(contract.original_ask).toBe('Import kiro spec "export" into an Intent Guard Intent Contract.');
  });

  it("does not let a prohibition inside the ask cancel its own out_of_scope item in drift", () => {
    const contract: IntentContract = {
      contract_id: "ic-20261017-aaaaaa",
      version: "1.0.0",
      original_ask: "Add CSV export for the fund table. Do not add PDF rendering.",
      in_scope: ["CSV export for the fund table"],
      out_of_scope: ["Do not add PDF rendering"],
      constraints: [],
      acceptance_criteria: [{ id: "ac-1", description: "Export downloads a CSV file", testable: true }],
      frozen_at: "2026-10-17T00:00:00Z",
      pivot_log: [],
    };
    const result = scoreDrift(contract, { changedPaths: ["src/pdf/rendering.ts"] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
  });
});

function contractWith(outOfScope: string[], constraints: IntentContract["constraints"] = []): IntentContract {
  return {
    contract_id: "ic-20261017-bbbbbb",
    version: "1.0.0",
    original_ask: "Add a theme toggle to the settings page.",
    in_scope: ["Theme toggle on the settings page"],
    out_of_scope: outOfScope,
    constraints,
    acceptance_criteria: [{ id: "ac-1", description: "Toggle switches the theme", testable: true }],
    frozen_at: "2026-10-17T00:00:00Z",
    pivot_log: [],
  };
}

describe("drift matchers are built from the prohibited thing, not the negation word", () => {
  it("does not count a contraction's stem as a term to match", () => {
    const result = scoreDrift(contractWith(["Won't ship payments"]), {
      changedPaths: ["src/won/handler.ts"],
    });
    expect(result.finding_details).toEqual([]);
  });

  it("does not dilute coverage with the negation word", () => {
    const result = scoreDrift(contractWith(["Don't modify billing"]), {
      changedPaths: ["src/billing/invoice.ts"],
    });
    const finding = result.finding_details.find((d) => d.category === "scope_creep");
    expect(finding?.strength).toBe("strong");
    // The rule text itself is reported as written.
    expect(finding?.rule_id).toBe("scope_creep:Don't modify billing");
  });

  it("strips each listed marker, stacked markers too, and keeps a rule with none", () => {
    expect(prohibitedSubject("- **Never**, do not edit the lockfile")).toBe("edit the lockfile");
    expect(prohibitedSubject("SHALL NOT expose payment tokens")).toBe("expose payment tokens");
    expect(prohibitedSubject("Must not call the network")).toBe("call the network");
    expect(prohibitedSubject("Should not log secrets")).toBe("log secrets");
    expect(prohibitedSubject("No new API endpoints")).toBe("new API endpoints");
    expect(prohibitedSubject("Notifications stay as they are")).toBe("Notifications stay as they are");
    expect(prohibitedSubject("Always run tests")).toBe("Always run tests");
  });

  it("strips the marker on a constraint as well", () => {
    const result = scoreDrift(
      contractWith([], [{ source: "user-stated", rule: "Cannot touch ledger", priority: "high" }]),
      { changedPaths: ["src/ledger/post.ts"] },
    );
    const finding = result.finding_details.find((d) => d.category === "constraint_violation");
    expect(finding?.strength).toBe("strong");
    expect(finding?.matched).toEqual(["ledger"]);
  });
});

function kiroSpec(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-labelled-"));
  const specDir = join(dir, ".kiro", "specs", "feature");
  mkdirSync(specDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(specDir, name), body, "utf8");
  return dir;
}

function importKiro(files: Record<string, string>) {
  return importSpecContract(kiroSpec(files), { format: "kiro", specDir: ".kiro/specs/feature" });
}

describe("a keyword match on a file name alone is not drift", () => {
  const sync = contractWith(["Do not change sync"]);

  it("does not count a match on the file name only, and says why", () => {
    const result = scoreDrift(sync, { changedPaths: ["src/components/SyncStatus.tsx"] });
    expect(result.categories.scope_creep).toBe(0);
    expect(result.action).toBe("proceed");
    const finding = result.finding_details.find((d) => d.category === "scope_creep");
    expect(finding?.strength).toBe("partial");
    expect(finding?.message).toContain("file name only");
  });

  it("still counts a match on a directory of the path", () => {
    const result = scoreDrift(sync, { changedPaths: ["src/sync/status.ts"] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
  });

  it("still counts a keyword match in the content signals", () => {
    const result = scoreDrift(sync, {
      changedPaths: ["src/components/SyncStatus.tsx"],
      signals: ["rewrote the sync engine"],
    });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
  });

  it("still counts a rule that names the path itself", () => {
    const result = scoreDrift(contractWith(["Do not touch src/components/SyncStatus.tsx"]), {
      changedPaths: ["src/components/SyncStatus.tsx"],
    });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
  });

  it("counts a word that names the changed file under the closed rule, and a *.ext word", () => {
    const dotEnv = scoreDrift(contractWith(["Never commit .env files"]), { changedPaths: [".env.local"] });
    expect(dotEnv.categories.scope_creep).toBeGreaterThan(0);
    const pem = scoreDrift(contractWith(["Do not add *.pem"]), { changedPaths: ["server.pem"] });
    expect(pem.categories.scope_creep).toBeGreaterThan(0);
  });

  it("does not demote a constraint: a file name is often a constraint's only evidence", () => {
    const contract = contractWith([], [{ source: "user-stated", rule: "Never change sync", priority: "critical" }]);
    const byName = scoreDrift(contract, { changedPaths: ["src/components/SyncStatus.tsx"] });
    expect(byName.categories.constraint_violation).toBe(90);
    const byDir = scoreDrift(contract, { changedPaths: ["src/sync/status.ts"] });
    expect(byDir.categories.constraint_violation).toBe(90);
  });
});

describe("path budget suggestions from the ask", () => {
  function repo(dirs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "ig-paths-"));
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
    return root;
  }

  it("suggests a slash path as a directory glob and a file with a known extension as itself", () => {
    const suggestions = suggestPathBudgets(
      "Fix the parser in `src/parser/` and update docs/usage.md and README.md, read/write stays, see https://example.com/a/b.",
      repo(["src", "docs"]),
    );
    expect(suggestions).toEqual(["src/parser/**", "docs/usage.md", "README.md"]);
  });

  it("suggests a word that names a top-level directory of the repository", () => {
    expect(suggestPathBudgets("Only change packages, nothing in tests.", repo(["packages", "scripts"]))).toEqual([
      "packages/**",
    ]);
  });

  it("does not suggest a plain word with no repository to check it against", () => {
    expect(suggestPathBudgets("Only change packages.")).toEqual([]);
  });

  it("drops tokens the budget matcher could never match", () => {
    // Each is path-shaped (an extension, a trailing slash), so only the
    // matcher's own validation can drop it.
    expect(suggestPathBudgets("Leave ../secrets/config.json and /etc/app/ alone.", repo([]))).toEqual([]);
  });

  it("never writes a suggestion into the draft", () => {
    const draft = draftContract({ userText: "Fix the parser in src/parser/." });
    expect(draft.budget).toBeUndefined();
  });
});

describe("import-spec reads only labelled scope sections", () => {
  it("ignores prose outside a labelled section, such as a competitor survey", () => {
    const imported = importKiro({
      "requirements.md": [
        "# Export feature",
        "",
        "## Landscape",
        "",
        "Other tools never offer offline export and must not be copied wholesale.",
        "",
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "## Out of scope",
        "",
        "- PDF rendering",
      ].join("\n"),
    });
    const all = JSON.stringify(imported.contract).toLowerCase();
    expect(all).not.toContain("offline export");
    expect(imported.contract.in_scope.join("\n")).toContain("CSV export button");
    expect(imported.contract.out_of_scope).toContain("PDF rendering");
    expect(imported.sections).toEqual(["requirements.md: Requirements", "requirements.md: Out of scope"]);
    expect(imported.warnings).toEqual([]);
  });

  it("recognises the common spellings and keeps nested headings inside a labelled section", () => {
    const imported = importKiro({
      "requirements.md": [
        "# Requirements Document",
        "## Introduction",
        "This feature never touches the ledger today.",
        "## Requirements",
        "### Requirement 1: Export",
        "#### Acceptance Criteria",
        "1. WHEN a manager exports, THE SYSTEM SHALL include invoice totals.",
        "## Non-goals",
        "- Real-time sync",
        "## Constraints",
        "- MUST NOT call the billing provider",
      ].join("\n"),
    });
    expect(imported.sections).toEqual([
      "requirements.md: Requirements",
      "requirements.md: Non-goals",
      "requirements.md: Constraints",
    ]);
    expect(JSON.stringify(imported.contract)).not.toContain("ledger");
    expect(imported.contract.out_of_scope).toEqual(
      expect.arrayContaining(["Real-time sync", "MUST NOT call the billing provider"]),
    );
    expect(JSON.stringify(imported.contract.acceptance_criteria)).toContain("invoice totals");
  });

  // Each shape alone under a labelled heading, so no other rule can hide it.
  // Every line here would be extracted if it were kept (a "no" or "should
  // not" is a prohibition in ordinary prose), and none carries one of the
  // explicit markers a Gherkin line is kept for.
  const gherkinCases: Array<{ name: string; lines: string[]; absent: string }> = [
    {
      name: "a scenario heading and its body",
      lines: ["### Scenario: manager exports", "The export should not include drafts."],
      absent: "include drafts",
    },
    {
      name: "plain Given, When, Then, And and But steps",
      lines: ["Given a manager on the report page", "When they never pick a format", "Then no file is downloaded", "And no button stays enabled", "But no dialog opens"],
      absent: "never",
    },
    {
      name: "a bold step line",
      lines: ["1. **Given** an empty table, **When** exporting, **Then** no rows are written"],
      absent: "no rows",
    },
    {
      name: "a Feature block",
      lines: ["Feature: export", "  Background:", "    The export should not include drafts."],
      absent: "include drafts",
    },
    {
      // No trailing pipe: valid GFM, and not a row extraction's own table
      // filter recognises.
      name: "a table",
      lines: ["| Field | Must not be empty", "|-------|------------------"],
      absent: "must not be empty",
    },
  ];
  for (const { name, lines, absent } of gherkinCases) {
    it(`strips ${name} from a labelled section`, () => {
      const imported = importKiro({
        "requirements.md": ["## Requirements", "", "- Add the CSV export button", "", ...lines].join("\n"),
      });
      const all = JSON.stringify({ ...imported.contract, original_ask: "" }).toLowerCase();
      expect(all).not.toContain(absent);
      expect(imported.contract.in_scope.join("\n")).toContain("CSV export button");
    });
  }

  // 1.9.0 read these as prohibitions and 1.10.0 dropped them with the rest of
  // the block. A Gherkin line with an explicit prohibition marker (SHALL NOT,
  // MUST NOT, never, do not, don't) is kept, without its step keyword.
  const auditScenario = [
    "# Requirements",
    "",
    "## Requirement 1: Export",
    "",
    "Scenario: export a report",
    "  Given a saved report",
    "  When I export it",
    "  Then the system SHALL NOT email the file",
    "  And the exporter must never write to the audit log",
  ].join("\n");

  it("keeps an explicit prohibition written as a Then or And step, as out_of_scope", () => {
    const imported = importKiro({ "requirements.md": auditScenario });
    const out = imported.contract.out_of_scope.join("\n");
    expect(out).toMatch(/SHALL NOT email the file/);
    expect(out).toMatch(/never write to the audit log/);
    expect(out).not.toMatch(/^(?:Then|And)\b/m);
    const all = JSON.stringify({ ...imported.contract, original_ask: "" }).toLowerCase();
    expect(all).not.toContain("saved report");
    expect(all).not.toContain("export it");
    const drift = scoreDrift({ ...imported.contract, frozen_at: "2026-10-18T00:00:00Z" }, {
      changedPaths: ["src/email/send.ts"],
    });
    expect(drift.categories.scope_creep).toBeGreaterThan(0);
  });

  it("still imports nothing from a scenario whose steps are all positive", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "Scenario: export a report",
        "  Given a saved report",
        "  When I export it",
        "  Then the file is emailed to the owner",
        "  And the audit log records the export",
        "  But no copy is kept on the server",
      ].join("\n"),
    });
    const all = JSON.stringify({ ...imported.contract, original_ask: "" }).toLowerCase();
    expect(all).not.toContain("emailed");
    expect(all).not.toContain("audit log");
    // An expected outcome written with "no" is not one of the kept markers.
    expect(all).not.toContain("copy is kept");
    expect(imported.contract.out_of_scope).toEqual([]);
  });

  it("keeps an explicit prohibition in a scenario heading's body and in a bold Then step", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "### Scenario: manager exports",
        "The export must not include drafts.",
        "",
        "## Constraints",
        "",
        "1. **Given** an empty table, **When** exporting, **Then** the system SHALL NOT write rows",
      ].join("\n"),
    });
    const out = imported.contract.out_of_scope.join("\n");
    expect(out).toMatch(/must not include drafts/i);
    expect(out).toMatch(/SHALL NOT write rows/);
    expect(JSON.stringify(imported.contract).toLowerCase()).not.toContain("empty table");
  });

  it("drops a Given or When step even when it says never", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "Given a user who has never exported",
        "When they never pick a format",
        "Then the default format is CSV",
      ].join("\n"),
    });
    expect(JSON.stringify(imported.contract).toLowerCase()).not.toContain("never");
  });

  it("drops a bold When segment that says never and keeps the Then segment of the same line", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "1. **When** the user has never consented, **Then** the system SHALL NOT send push alerts",
      ].join("\n"),
    });
    const all = JSON.stringify(imported.contract).toLowerCase();
    expect(all).not.toContain("never consented");
    expect(imported.contract.out_of_scope.join("\n")).toMatch(/SHALL NOT send push alerts/);
  });

  it("warns, naming the step, when it drops a Given or When step that carries a prohibition marker", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "Scenario: consent",
        "  Given a saved report",
        "  When the mailer must never send newsletters",
        "  Then the default format is CSV",
        "",
        "1. **When** the user has never consented, **Then** the system SHALL NOT send push alerts",
      ].join("\n"),
    });
    const dropped = imported.warnings.filter((w) => w.includes("not imported as a rule"));
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain("When the mailer must never send newsletters");
    expect(dropped[0]).toContain("requirements.md");
    expect(dropped[1]).toContain("the user has never consented");
    // A step with no marker is dropped silently, as before.
    expect(imported.warnings.join("\n")).not.toContain("a saved report");
  });

  // 2026-10-27 N1: 1.9.0 imported both of these as prohibitions; 1.10.1
  // drops them with no warning. They stay dropped (should not and cannot
  // mostly state an outcome), and import-spec now says so.
  it("warns, naming the step, when it drops a Then or And step written with should not or cannot", () => {
    const imported = importKiro({
      "requirements.md": [
        "## Requirements",
        "",
        "- Add the CSV export button",
        "",
        "Scenario: export a report",
        "  Given a user who cannot log in",
        "  When I export it",
        "  Then the system should not email the file",
        "  And the exporter cannot write to the audit log",
        "  But no copy is kept on the server",
        "  And the exporter must never call the ledger; it can't retry",
        "",
        "1. **Given** a report, **Then** the job should not page anyone",
      ].join("\n"),
    });
    const unkept = imported.warnings.filter((w) => w.includes("reads like a prohibition"));
    expect(unkept).toHaveLength(4);
    expect(unkept[0]).toContain("Then the system should not email the file");
    expect(unkept[0]).toContain("requirements.md");
    expect(unkept[1]).toContain("And the exporter cannot write to the audit log");
    expect(unkept[2]).toContain("it can't retry");
    expect(unkept[3]).toContain("the job should not page anyone");
    const all = imported.warnings.join("\n");
    // A Given or When step is never imported, and "no" opens most outcomes:
    // neither is warned about.
    expect(all).not.toContain("cannot log in");
    expect(all).not.toContain("copy is kept");
    // Still not imported; the marked clause of the mixed line still is.
    const out = imported.contract.out_of_scope.join("\n");
    expect(out).not.toMatch(/email the file|audit log|page anyone/);
    expect(out).toMatch(/never call the ledger/);
  });

  // 2026-10-27 N4b: without the table-row guard inside a scenario body, a
  // table cell carrying a marker became an out_of_scope item.
  it("drops a table row inside a scenario heading's body, even one carrying a marker", () => {
    const spec = [
      "## Requirements",
      "",
      "- Add the CSV export button",
      "",
      "### Scenario: manager exports",
      "| Field | the export must never include drafts |",
      "|-------|--------------------------------------|",
    ].join("\n");
    expect(selectLabelledSections(spec).text).not.toContain("include drafts");
    const imported = importKiro({ "requirements.md": spec });
    expect(imported.contract.out_of_scope.join("\n")).not.toContain("include drafts");
  });

  // A line the Gherkin keep accepts must land in out_of_scope, never in
  // in_scope, where its tokens would cancel a real out_of_scope item. The
  // expected kept set is written out here, not derived from the marker
  // module, so normalizeMarkerText is pinned by the curly and spacing rows.
  const markerCandidates: Array<[string, boolean]> = [
    ["SHALL NOT", true], ["shall not", true], ["SHALL  NOT", true], ["MUST NOT", true],
    ["must\tnot", true], ["must never", true], ["never", true],
    ["do not", true], ["Do  not", true], ["don't", true],
    ["don’t", true], ["don‘t", true],
    ["should not", false], ["cannot", false], ["can't", false], ["will not", false],
    ["won't", false], ["avoid", false], ["no longer", false],
  ];
  // Two shapes: a spec with a bullet list (extraction's clause parser then
  // reads bullets only) and one with none (it reads every sentence, which is
  // where a subject in front of the marker became an in_scope item).
  for (const [marker, explicit, scope] of markerCandidates.flatMap(([m, kept]) => [
    [m, kept, "- Add the CSV export button"] as const,
    [m, kept, "Add the CSV export button."] as const,
  ])) {
    it(`routes a kept Gherkin Then step with ${JSON.stringify(marker)} to out_of_scope, never to in_scope (${scope.startsWith("-") ? "bullets" : "prose"})`, () => {
      const spec = [
        "## Requirements",
        "",
        scope,
        "",
        "Scenario: digest",
        "  Given a saved report",
        // "archive" is an extraction action verb: a subject left in front of
        // the marker would become an in_scope item of its own.
        `  Then the archive job ${marker} touch the weekly digest bucket`,
      ].join("\n");
      const imported = importKiro({ "requirements.md": spec });
      const inScope = imported.contract.in_scope.join("\n").toLowerCase();
      const outOfScope = imported.contract.out_of_scope.join("\n").toLowerCase();
      // The keep accepts exactly the listed markers, no more and no fewer.
      expect(selectLabelledSections(spec).text.includes("digest bucket")).toBe(explicit);
      expect(inScope).not.toContain("digest bucket");
      expect(inScope).not.toContain("archive");
      if (explicit) {
        expect(outOfScope).toContain("touch the weekly digest bucket");
      } else {
        expect(outOfScope).not.toContain("digest bucket");
      }
    });
  }

  // The 2026-10-18 review's g3 and g4 specs: several kept lines in a row. In
  // the second fix round a comma-list capture ran across the newline into the
  // next kept line, and the But line's own item was deduped away.
  const g3 = [
    "# Requirements Document",
    "",
    "## Requirements",
    "",
    "### Requirement 1: Export",
    "",
    "- Add the CSV export button",
    "",
    "Scenario: export",
    "  Given a saved report",
    "  Then the exporter and the mailer must never write to the audit log",
    "  And the payments table must never be dropped",
    "  And the uploader never touches the archive bucket, and the exporter emails the owner",
    "  And the exporter never retries; the scheduler reruns the nightly job",
    "  But the uploader do not touch the telemetry bucket",
    "  Then the system SHALL NOT email the file. The owner receives a download link",
  ].join("\n");
  const g4 = [
    "# Requirements Document",
    "",
    "## Requirements",
    "",
    "### Requirement 1: Export",
    "",
    "- Add the CSV export button",
    "",
    "Scenario: export",
    "  Given a saved report",
    "  Then the system SHALL NOT email the file",
    "  And the exporter must never write to the audit log",
    "  But the uploader do not touch the telemetry bucket",
    "  And the archiver never compresses the ledger",
  ].join("\n");
  const g1 = [
    "## Requirements",
    "",
    "- Add the CSV export button",
    "",
    "Scenario: consent",
    "  Given a saved report",
    "  But the uploader don’t touch the telemetry bucket",
  ].join("\n");

  it.each([
    ["g1 (curly don't)", g1],
    ["g3 (six kept lines)", g3],
    ["g4 (four kept lines)", g4],
  ])("imports each kept Gherkin line as its own out_of_scope item and blocks on it: %s", (_name, spec) => {
    const imported = importKiro({ "requirements.md": spec });
    const out = imported.contract.out_of_scope;
    expect(out.some((item) => /^do(?: not|n't) touch the telemetry bucket$/i.test(item))).toBe(true);
    // No item runs across two kept lines.
    for (const item of out) expect(item).not.toMatch(/telemetry.*(?:audit|email|ledger)|(?:audit|archive|ledger).*telemetry/i);
    // A kept line is an out_of_scope item only, never an acceptance criterion.
    expect(JSON.stringify(imported.contract.acceptance_criteria)).not.toMatch(/telemetry|audit log/i);
    const drift = scoreDrift({ ...imported.contract, frozen_at: "2026-10-18T00:00:00Z" }, {
      changedPaths: ["src/telemetry/bucket.ts"],
    });
    expect(drift.action).not.toBe("proceed");
  });

  it("routes kept Gherkin lines through an Out of scope section, not through prohibition re-extraction", () => {
    const selected = selectLabelledSections(g4).text.split("\n");
    const heading = selected.findIndex((line) => /^#{1,6} Out of scope\b/.test(line));
    expect(heading).toBeGreaterThan(-1);
    expect(selected.slice(heading + 1)).toEqual([
      "- SHALL NOT email the file",
      "- never write to the audit log",
      "- do not touch the telemetry bucket",
      "- never compresses the ledger",
    ]);
  });

  // The review's g7: every marked clause after a semicolon is its own rule, as
  // 1.9.0 enforced them; only a marker-less clause is dropped.
  it.each(["src/audit/log.ts", "src/ledger/service.ts", "src/email/send.ts", "src/archive/bucket.ts"])(
    "keeps every marked clause of a kept line split at semicolons, so %s blocks",
    (path) => {
      const imported = importKiro({
        "requirements.md": [
          "# Requirements Document",
          "",
          "## Requirements",
          "",
          "- Add the CSV export button",
          "",
          "Scenario: export",
          "  Given a saved report",
          "  Then the exporter must never write to the audit log; it must never call the ledger service",
          "  And the system SHALL NOT email the file; SHALL NOT upload to the archive bucket",
          "  And the exporter never retries; the scheduler reruns the nightly job",
        ].join("\n"),
      });
      const out = imported.contract.out_of_scope;
      expect(out).toEqual(
        expect.arrayContaining([
          "never write to the audit log",
          "never call the ledger service",
          "SHALL NOT email the file",
          "SHALL NOT upload to the archive bucket",
          "never retries",
        ]),
      );
      expect(out.join("\n")).not.toMatch(/scheduler/);
      const drift = scoreDrift({ ...imported.contract, frozen_at: "2026-10-18T00:00:00Z" }, { changedPaths: [path] });
      expect(drift.action).not.toBe("proceed");
    },
  );

  it("keeps a kept line's marked clauses only, so a following positive clause is not forbidden", () => {
    const imported = importKiro({ "requirements.md": g3 });
    const out = imported.contract.out_of_scope.join("\n");
    expect(out).toMatch(/never retries/);
    expect(out).not.toMatch(/scheduler reruns/);
    expect(out).not.toMatch(/owner receives/);
  });

  it("keeps the 1.10.0 out_of_scope reading of an ask with a mid-sentence don't", () => {
    const toolbar = draftContract({
      userText: "Add a mobile toolbar. Users don't see the export button on mobile today.",
    });
    const drift = scoreDrift(
      { ...toolbar, frozen_at: "2026-10-18T00:00:00Z" },
      { changedPaths: ["src/export/button.ts", "src/mobile/toolbar.ts"] },
    );
    expect(drift.action).toBe("proceed");
    for (const ask of [
      "Make the importer skip rows that don't parse, and log them to the audit table.",
      "Add a retry button. Today customers who don't receive the invoice email have to call support.",
      "Speed up the sync badge, and please don't touch the payments webhook.",
    ]) {
      const items = draftContract({ userText: ask }).out_of_scope.map((item) => item.toLowerCase());
      // No duplicate: no item is contained in another.
      for (const [i, item] of items.entries()) {
        expect(items.filter((other, j) => j !== i && other.includes(item))).toEqual([]);
      }
    }
  });

  it("keeps the prohibition on the next line its own item when a comma list ends a line", () => {
    const draft = draftContract({
      userText: [
        "- Add the CSV export button",
        "never touch the archive bucket, the ledger or the mailer",
        "do not touch the telemetry bucket",
      ].join("\n"),
    });
    expect(draft.out_of_scope.join("\n")).toMatch(/do not touch the telemetry bucket/);
    for (const item of draft.out_of_scope) expect(item).not.toMatch(/mailer.*telemetry/);
  });

  it("keeps a prose line that starts with When outside a run of steps", () => {
    const imported = importKiro({
      "requirements.md": ["## Requirements", "When exporting, never include payment tokens."].join("\n"),
    });
    expect(imported.contract.out_of_scope.join("\n")).toMatch(/never include payment tokens/i);
  });

  it("keeps an EARS requirement line, which is not a Gherkin step", () => {
    const imported = importKiro({
      "requirements.md": ["## Requirements", "WHEN a user exports THEN the system SHALL NOT include payment tokens."].join("\n"),
    });
    expect(imported.contract.out_of_scope.join("\n")).toMatch(/not include payment tokens/i);
  });

  it("yields an empty contract and a warning naming the headings it looked for when nothing is labelled", () => {
    const imported = importKiro({
      "requirements.md": "# Export\n\nNever ship PDF export. Add a CSV export button.\n",
      "tasks.md": "- [ ] Add the export button\n",
    });
    expect(imported.contract.out_of_scope).toEqual([]);
    expect(imported.contract.in_scope).toEqual([NO_LABELLED_SCOPE_ITEM]);
    expect(JSON.stringify(imported.contract)).not.toMatch(/pdf|csv|export button/i);
    expect(imported.sections).toEqual([]);
    expect(imported.warnings).toHaveLength(1);
    for (const heading of ["Scope", "In scope", "Out of scope", "Non-goals", "Requirements", "Constraints"]) {
      expect(imported.warnings[0]).toContain(heading);
    }
    expect(validateIntentContract(imported.contract).valid).toBe(true);
  });
});

describe("near-identical rules are deduped, keeping the longer", () => {
  it("merges rules identical after case, whitespace, punctuation and the negation marker", () => {
    const { kept, replaced } = dedupeRules(["Never touch billing.", "Do NOT  touch billing", "No touch billing!"]);
    expect(kept).toEqual(["Do NOT  touch billing"]);
    expect(replaced).toEqual([
      { kept: "Do NOT  touch billing", replaced: "Never touch billing." },
      { kept: "Do NOT  touch billing", replaced: "No touch billing!" },
    ]);
  });

  it("keeps the superset when one rule contains another, in the earlier rule's place", () => {
    const { kept, replaced } = dedupeRules(["PDF export", "Webhook handlers", "Do not add any PDF export"]);
    expect(kept).toEqual(["Do not add any PDF export", "Webhook handlers"]);
    expect(replaced).toEqual([{ kept: "Do not add any PDF export", replaced: "PDF export" }]);
  });

  it("keeps both when the superset has words of its own, so the narrower matcher survives", () => {
    const { kept } = dedupeRules(["Do not touch billing", "Do not touch billing (Stripe or Braintree) code"]);
    expect(kept).toHaveLength(2);
  });

  it("never merges rules of opposite polarity", () => {
    const { kept } = dedupeRules(["Use the shared logger", "Never use the shared logger"], { polarity: true });
    expect(kept).toHaveLength(2);
  });

  it("never absorbs a one-word rule into a longer one", () => {
    const { kept } = dedupeRules(["Sync", "Do not change the sync status display"]);
    expect(kept).toHaveLength(2);
  });

  it("dedupes a drafted out_of_scope list", () => {
    const draft = draftContract({
      userText: "Add CSV export. Never touch billing. Do not touch billing.",
    });
    const billing = draft.out_of_scope.filter((item) => /billing/i.test(item));
    expect(billing).toEqual(["Do not touch billing"]);
  });

  it("reports what each kept rule replaced", () => {
    const { replaced } = draftContractDetailed({
      userText: "Add CSV export. Never touch billing. Do not touch billing.",
    });
    expect(replaced).toEqual([{ kept: "Do not touch billing", replaced: "Never touch billing" }]);
  });

  it("dedupes loaded constraints by polarity, keeping the longer rule and the higher priority", () => {
    const deduped = dedupeConstraints([
      { source: "AGENTS.md", rule: "Never commit secrets", priority: "critical" },
      { source: "CLAUDE.md", rule: "Never commit secrets at all", priority: "high" },
      { source: "CLAUDE.md", rule: "Always commit secrets", priority: "low" },
    ]);
    expect(deduped.map((c) => c.rule)).toEqual(["Never commit secrets at all", "Always commit secrets"]);
    expect(deduped[0].priority).toBe("critical");
  });
});

describe("rule extraction: a paragraph or list item is the unit", () => {
  it("joins a hard-wrapped paragraph into one rule, never a fragment", () => {
    const md = [
      "## Rules",
      "",
      "Never push directly to the main branch or force-push over a",
      "teammate's work without asking first.",
    ].join("\n");
    const rules = extractConstraintsFromMarkdown(md, "AGENTS.md");
    expect(rules.map((r) => r.rule)).toEqual([
      "Never push directly to the main branch or force-push over a teammate's work without asking first.",
    ]);
  });

  it("joins a wrapped list item and keeps the next item separate", () => {
    const md = [
      "- MUST run the full test suite before claiming a change is",
      "  complete, and paste the output.",
      "- Prefer small diffs",
    ].join("\n");
    const rules = extractConstraintsFromMarkdown(md, "CLAUDE.md");
    expect(rules.map((r) => r.rule)).toEqual([
      "MUST run the full test suite before claiming a change is complete, and paste the output.",
      "Prefer small diffs",
    ]);
  });

  it("does not mark the continuation line of a wrapped rule critical on its own", () => {
    const md = [
      "Generated files are rebuilt by CI. Do not edit them by hand, and",
      "never commit the dist directory.",
    ].join("\n");
    const rules = extractConstraintsFromMarkdown(md, "CLAUDE.md");
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe(
      "Generated files are rebuilt by CI. Do not edit them by hand, and never commit the dist directory.",
    );
    expect(rules[0].priority).toBe("critical");
  });

  it("ends a unit at a blank line, a heading, and a list marker", () => {
    const md = [
      "You must keep changes small",
      "# Next",
      "You should write tests",
      "- Never commit secrets",
      "",
      "Always run lint",
    ].join("\n");
    const rules = extractConstraintsFromMarkdown(md, "AGENTS.md");
    expect(rules.map((r) => r.rule)).toEqual([
      "You must keep changes small",
      "You should write tests",
      "Never commit secrets",
      "Always run lint",
    ]);
  });

  it("splits a paragraph too long to be one rule into whole sentences only", () => {
    const filler = "This paragraph explains the repository layout in some detail".repeat(4);
    const md = [
      `${filler}.`,
      "Never commit generated files to the repository.",
      "The rest is context that carries no rule at all and goes on for a",
      "while longer.",
    ].join("\n");
    const rules = extractConstraintsFromMarkdown(md, "AGENTS.md");
    expect(rules.map((r) => r.rule)).toEqual([
      "Never commit generated files to the repository.",
    ]);
  });

  it("skips YAML front matter in a rules file", () => {
    const md = ["---", "description: Always use the logger", "globs: src/**", "---", "- Never log secrets"].join(
      "\n",
    );
    const rules = extractConstraintsFromMarkdown(md, "cursor-rules");
    expect(rules.map((r) => r.rule)).toEqual(["Never log secrets"]);
  });
});
