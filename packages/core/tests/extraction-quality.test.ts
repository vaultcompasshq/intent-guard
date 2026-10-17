import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import { dedupeConstraints, dedupeRules, extractConstraintsFromMarkdown } from "../src/constraints.js";
import { ORIGINAL_ASK_MAX, draftContract, draftContractDetailed } from "../src/extract.js";
import { scoreDrift } from "../src/drift.js";
import { prohibitedSubject } from "../src/tokenize.js";
import { suggestPathBudgets } from "../src/path-suggestions.js";
import { NO_LABELLED_SCOPE_ITEM, importSpecContract } from "../src/spec-bridge.js";
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
  const gherkinCases: Array<{ name: string; lines: string[]; absent: string }> = [
    {
      name: "a scenario heading and its body",
      lines: ["### Scenario: manager exports", "The export must not include drafts."],
      absent: "include drafts",
    },
    {
      name: "plain Given, When, Then, And and But steps",
      lines: ["Given a manager on the report page", "When they never pick a format", "Then no file is downloaded", "And the button never stays enabled", "But never the dialog"],
      absent: "never",
    },
    {
      name: "a bold step line",
      lines: ["1. **Given** an empty table, **When** exporting, **Then** no rows are written"],
      absent: "no rows",
    },
    {
      name: "a Feature block",
      lines: ["Feature: export", "  Background:", "    The export must not include drafts."],
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
