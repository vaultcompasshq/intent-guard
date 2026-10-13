import { describe, it, expect } from "vitest";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import { draftContract, OUT_OF_SCOPE_CAP } from "../src/extract.js";

// Heading-aware extraction. A real spec says what it will NOT do under a
// "Non-goals" heading, describes what is broken today under "Problem" or
// "Background", and summarises in tables. Extraction that ignores all of that
// authorises the non-goals and forbids the fix (2026-10-12 audit, F1).

function draft(lines: string[]) {
  return draftContract({ userText: lines.join("\n") });
}

function lower(items: string[]): string {
  return items.join("\n").toLowerCase();
}

describe("Non-goals and out-of-scope headings route to out_of_scope", () => {
  const headings = [
    "### Non-goals",
    "## Non goals",
    "## NON-GOALS",
    "## 5. Out of Scope",
    "## Out-of-scope",
    "### Won't have",
    "### Will not",
    "## Not in scope",
    "## Excluded",
    "#### Explicitly out of scope",
    "**Non-goals**",
    "**Out of scope:**",
  ];

  for (const heading of headings) {
    it(`routes bullets under "${heading}" to out_of_scope and never to in_scope`, () => {
      const contract = draft([
        "# Payments retry",
        "## Requirements",
        "- Add bounded retry logic to the payments client",
        heading,
        "- Rewriting any backend or the orchestration layer",
        "- Kubernetes manifests, Helm charts, or a cloud deployment story",
      ]);
      expect(lower(contract.out_of_scope)).toContain("rewriting any backend");
      expect(lower(contract.out_of_scope)).toContain("kubernetes manifests");
      expect(lower(contract.in_scope)).not.toContain("rewriting any backend");
      expect(lower(contract.in_scope)).not.toContain("kubernetes");
      expect(lower(contract.in_scope)).toContain("bounded retry");
    });
  }

  it("routes prose sentences under the heading too, one item per sentence", () => {
    const contract = draft([
      "## Goals",
      "- Add bounded retry logic to the payments client",
      "## Out of scope",
      "Rate limiting the public API. Migrating the ledger database.",
    ]);
    expect(contract.out_of_scope).toEqual(
      expect.arrayContaining(["Rate limiting the public API", "Migrating the ledger database"]),
    );
  });

  it("joins wrapped prose lines before splitting sentences", () => {
    const contract = draft([
      "## Deferred work",
      "If the project later needs untrusted screens, design a separate",
      "sandboxed iframe architecture. Do not bundle that into this fix.",
    ]);
    expect(contract.out_of_scope).toEqual(
      expect.arrayContaining([
        "If the project later needs untrusted screens, design a separate sandboxed iframe architecture",
        "Do not bundle that into this fix",
      ]),
    );
  });

  it("joins a wrapped bullet and keeps its first sentence", () => {
    const contract = draft([
      "## Non-goals",
      "- Rewriting the engineering journal. It is an append-only record and stays as",
      "written.",
      "- Multi-tenancy, RBAC, SSO, or a hosted deployment",
    ]);
    expect(contract.out_of_scope).toContain("Rewriting the engineering journal");
    expect(lower(contract.out_of_scope)).not.toContain("written");
  });

  it("ends the section at the next heading of the same or a higher level", () => {
    const contract = draft([
      "## Non-goals",
      "- Kubernetes manifests or Helm charts",
      "## Requirements",
      "- Add an auth token check to every route",
    ]);
    expect(lower(contract.out_of_scope)).toContain("kubernetes manifests");
    expect(lower(contract.in_scope)).toContain("auth token check");
    expect(lower(contract.out_of_scope)).not.toContain("auth token");
  });

  it("does not let a child heading inherit the out-of-scope kind", () => {
    // A child heading with no kind of its own is neutral: a requirement
    // nested under a Non-goals heading by a sloppy outline is still a
    // requirement.
    const contract = draft([
      "## Non-goals",
      "- Rewriting the backend",
      "### Requirement 2",
      "- Add an auth token check to every route",
    ]);
    expect(lower(contract.out_of_scope)).toContain("rewriting the backend");
    expect(lower(contract.in_scope)).toContain("auth token check");
    expect(lower(contract.out_of_scope)).not.toContain("auth token");
  });

  it("treats a plain label line ending in a colon as a list-only out-of-scope heading", () => {
    const contract = draft([
      "## Threat model",
      "Out of scope for this fix:",
      "- malicious agent-authored screen HTML",
      "- malicious same-origin vendored JavaScript loaded by a companion",
      "  screen",
      "This boundary is intentional and the design adds a narrow message bridge.",
      "## Design",
      "- Add a bootstrap key to every keyed load",
    ]);
    expect(contract.out_of_scope).toEqual(
      expect.arrayContaining([
        "malicious agent-authored screen HTML",
        "malicious same-origin vendored JavaScript loaded by a companion screen",
      ]),
    );
    // The prose after the list is not part of it.
    expect(lower(contract.out_of_scope)).not.toContain("boundary is intentional");
  });

  it("ends a bold out-of-scope pseudo-heading at the first line that is not a bullet", () => {
    const contract = draft([
      "**Out of scope**",
      "- Rate limiting the public API",
      "Add an auth token check to every route.",
    ]);
    expect(contract.out_of_scope).toContain("Rate limiting the public API");
    expect(lower(contract.in_scope)).toContain("auth token check");
  });

  it("routes Deferred work and Future work sections", () => {
    for (const heading of ["## Deferred Work", "## Future work"]) {
      const contract = draft([
        "## Goal",
        "- Add a bootstrap key to every keyed load",
        heading,
        "- Design a sandboxed iframe architecture for untrusted screens",
      ]);
      expect(lower(contract.out_of_scope)).toContain("sandboxed iframe");
      expect(lower(contract.in_scope)).not.toContain("sandboxed iframe");
    }
  });

  it("does not treat a heading that merely mentions scope as a non-goals heading", () => {
    const contract = draft([
      "## Scope of the retry change",
      "- Add bounded retry logic to the payments client",
    ]);
    expect(lower(contract.in_scope)).toContain("bounded retry");
    expect(contract.out_of_scope).toEqual([]);
  });

  it("routes a sentence that declares itself out of scope", () => {
    const contract = draft([
      "## Requirements",
      "15.8 RATE LIMITING IS OUT OF SCOPE, but the design SHALL record it as the next step.",
      "- Add an auth token check to every route",
    ]);
    expect(contract.out_of_scope).toContain("RATE LIMITING");
  });
});

describe("markdown tables are skipped for rule extraction", () => {
  it("never turns a table row into an out_of_scope or in_scope item", () => {
    const contract = draft([
      "## What this spec adds",
      "| Area | Gap today | Requirement |",
      "| --- | --- | --- |",
      "| Core contract | No stated rule for what core/ may own | R11 |",
      "| Container | Add a Node build stage | R18 |",
      "## Requirements",
      "- Add an auth token check to every route",
    ]);
    expect(lower(contract.out_of_scope)).not.toContain("no stated rule");
    expect(lower(contract.in_scope)).not.toContain("node build stage");
    expect(lower(contract.in_scope)).toContain("auth token check");
  });
});

describe("problem-statement sections are skipped for prohibition extraction", () => {
  for (const heading of [
    "## Problem",
    "## Problem statement",
    "## Background",
    "## Context",
    "## Current state",
    "## Current failures",
    "## Motivation",
  ]) {
    it(`does not forbid what "${heading}" says is missing today`, () => {
      const contract = draft([
        heading,
        "CI runs the frontend build but never npm test or npm run lint.",
        "The Dockerfile has no Node build stage.",
        "## Requirements",
        "- Run npm test and npm run lint in CI",
        "- Never commit generated bundles",
      ]);
      const out = lower(contract.out_of_scope);
      expect(out).not.toContain("npm test");
      expect(out).not.toContain("node build stage");
      expect(out).toContain("never commit generated bundles");
    });
  }

  it("covers only the list under a bold Background pseudo-heading", () => {
    const contract = draft([
      "**Background**",
      "- CI runs the frontend build but never npm test or npm run lint",
      "- The Dockerfile has no Node build stage",
      "Never commit generated bundles.",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).not.toContain("npm test");
    expect(out).not.toContain("node build stage");
    expect(out).toContain("never commit generated bundles");
  });

  it("returns the prose after a bold Background list to the ordinary section", () => {
    const contract = draft([
      "**Background**",
      "- The API is old",
      "Agents may refactor src/ but never billing/ code.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("never billing/ code");
  });

  it("keeps an explicit prohibition inside a problem section", () => {
    const contract = draft([
      "## Context",
      "The invoice job is slow and has no index. Agents MUST NOT touch billing/ during this work.",
      "Never edit migrations/. The old code never runs its tests.",
      "## Requirements",
      "- Add an index to the invoices query",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).toContain("must not touch billing/ during this work");
    expect(out).toContain("never edit migrations/");
    expect(out).not.toContain("no index");
    expect(out).not.toContain("never runs its tests");
  });

  it("treats Introduction as an ordinary section, as every Kiro requirements.md opens with it", () => {
    const contract = draft([
      "## Introduction",
      "This feature adds caching. Do not modify the payments service.",
      "The importer never writes outside the project root.",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).toContain("do not modify the payments service");
    // A bare never is only dropped in a problem section; Introduction is not one.
    expect(out).toContain("never writes outside the project root");
  });

  it("keeps an imperative Avoid inside a problem section (reviewer case problem_avoid)", () => {
    const contract = draftContract({
      userText: "# Spec\n\n## Problem\n\nThe worker is flaky. Avoid editing migrations/.\n\n## Plan\n\n- Add retries.\n",
    });
    expect(lower(contract.out_of_scope)).toContain("avoid editing migrations/");
  });

  it("keeps a leading No ... SHALL inside a problem section", () => {
    const contract = draft(["## Background", "No telemetry SHALL be sent to a third party."]);
    expect(lower(contract.out_of_scope)).toContain("no telemetry shall be sent to a third party");
  });

  it("still extracts prohibitions from a heading that only starts with a problem word", () => {
    const contract = draft([
      "## Context items",
      "- Never store context items unencrypted",
    ]);
    expect(lower(contract.out_of_scope)).toContain("never store context items unencrypted");
  });
});

describe('a "no X" next to a positive modal is not a prohibition', () => {
  it("does not forbid what a positive SHALL requirement asks for", () => {
    const contract = draft([
      "## Requirements",
      "CI SHALL run, with no cloud credentials: terraform fmt -check, terraform validate, tflint, and checkov.",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).not.toContain("no cloud");
    expect(out).not.toContain("checkov");
  });

  it("keeps a sentence-leading No ... SHALL as the prohibition it is", () => {
    const contract = draft(["## Requirements", "No telemetry SHALL be sent to a third party."]);
    expect(lower(contract.out_of_scope)).toContain("no telemetry");
  });

  it("keeps a coordinated never after a positive modal", () => {
    const contract = draft([
      "## Requirements",
      "The CLI must exit 2 and never write a partial contract file.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("never write a partial contract file");
  });

  it("keeps a sentence that mixes a positive modal, a modifier no, and an explicit SHALL NOT", () => {
    const contract = draft([
      "## Requirements",
      "The CLI SHALL exit 2 when no ref resolves and SHALL NOT write a contract file.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("shall not write a contract file");
  });

  // The modal exemption is judged per clause: a ";" or a comma that opens a
  // negated clause starts a new one, and only a no/never in the SAME clause
  // as the positive modal is a modifier.
  for (const [sentence, expected] of [
    ["The job SHALL run nightly; never write to prod.", "never write to prod"],
    ["Agents should never touch billing/ and must keep tests green.", "never touch billing/"],
    ["The deploy MUST use the staging key, never the prod key.", "never the prod key"],
    ["Workers SHALL retry failed jobs with no writes to billing/.", "no writes to billing/"],
  ] as const) {
    it(`keeps the prohibition in "${sentence}"`, () => {
      const contract = draft(["## Requirements", sentence]);
      expect(lower(contract.out_of_scope)).toContain(expected);
    });
  }

  it("keeps a no that is the object of the modal's own verb", () => {
    const contract = draft([
      "## Requirements",
      '2. plan SHALL show no wildcard Resource: "*" in IAM policies except where a service requires it.',
    ]);
    expect(lower(contract.out_of_scope)).toContain("no wildcard");
  });

  it("does not read a Kiro user story as a rule", () => {
    const contract = draft([
      "### R13 The web API is decomposed",
      "**User story:** As a contributor fixing one endpoint, I do not want to open a",
      "1,791-line module.",
      "13.1 THE SYSTEM SHALL NOT keep all routes in one module.",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).not.toContain("do not want");
    expect(out).toContain("shall not keep all routes in one module");
  });

  it("keeps a with-no phrase that names a path, even without an action noun", () => {
    const contract = draft([
      "## Requirements",
      "The release job SHALL pass with no billing/ files in its diff.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("no billing/ files in its diff");
  });

  it("still treats a missing resource beside a positive modal as a modifier", () => {
    const contract = draft([
      "## Requirements",
      "CI SHALL run with no cloud credentials.",
    ]);
    const out = lower(contract.out_of_scope);
    expect(out).not.toContain("no cloud credentials");
  });

  it("keeps an explicit SHALL NOT in the same sentence", () => {
    const contract = draft([
      "## Requirements",
      "THE RUNTIME STAGE SHALL NOT install build-essential.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("shall not install build-essential");
  });
});

describe("the out_of_scope cap applies after heading routing", () => {
  it("keeps a real prohibition that problem-statement noise used to crowd out", () => {
    const noise = Array.from(
      { length: 10 },
      (_, i) => `Module ${i} has no owner and never runs its checker${i} suite.`,
    );
    const contract = draft([
      "## Background",
      ...noise,
      "## Non-goals",
      "- Rewriting the engineering journal",
      "## Requirements",
      "- Add an owner field to every module",
      "- Do not touch the billing ledger",
    ]);
    expect(contract.out_of_scope.length).toBeLessThanOrEqual(OUT_OF_SCOPE_CAP);
    expect(contract.out_of_scope.slice(0, 2)).toEqual([
      "Rewriting the engineering journal",
      "Do not touch the billing ledger",
    ]);
    expect(lower(contract.out_of_scope)).not.toContain("no owner");
  });

  it("ranks routed non-goals first, then explicit prohibitions, then the rest", () => {
    const contract = draft([
      "## Non-goals",
      "- Rewriting the engineering journal",
      "## Requirements",
      "- Never store tokens in plain text",
      "- The runtime stage SHALL NOT install build-essential",
      "- Do not touch the billing ledger",
      "- No access keys in .env",
    ]);
    const out = contract.out_of_scope;
    const at = (needle: string) => out.findIndex((item) => item.toLowerCase().includes(needle));
    expect(at("rewriting the engineering journal")).toBe(0);
    expect(at("rewriting the engineering journal")).toBeLessThan(at("shall not install build-essential"));
    expect(at("rewriting the engineering journal")).toBeLessThan(at("do not touch the billing ledger"));
    expect(at("shall not install build-essential")).toBeLessThan(at("never store tokens"));
    expect(at("do not touch the billing ledger")).toBeLessThan(at("never store tokens"));
    expect(at("no access keys")).toBeGreaterThan(-1);
  });

  it("caps at the schema's limit, so a draft always validates", () => {
    const contract = draft([
      "## Non-goals",
      ...Array.from({ length: 20 }, (_, i) => `- Rewriting subsystem number ${i}`),
      "## Requirements",
      "- Add an owner field to every module",
    ]);
    expect(contract.out_of_scope).toHaveLength(OUT_OF_SCOPE_CAP);
    expect(contract.out_of_scope[0]).toBe("Rewriting subsystem number 0");
    expect(validateIntentContract(contract).valid).toBe(true);
  });
});

// The reviewer's probe cases (2026-10-13), each run through the base build
// (bf3eb38, before heading-aware extraction). BASE_OUT is what that build put
// in out_of_scope. Heading-aware extraction may ADD items and may drop noise,
// but every prohibition the base kept for these inputs is a real rule, and
// dropping one silently is the failure this block exists to catch.
const REVIEW_CASES: Record<string, string> = {
  context_must_not:
    "# Billing cleanup\n\n## Context\n\nThe invoice job is slow. Agents MUST NOT touch billing/ during this work.\n\n## Requirements\n\n- Add an index to the invoices query.\n",
  intro_kiro:
    "# Requirements Document\n\n## Introduction\n\nThis feature adds caching. Do not modify the payments service.\n\n## Requirements\n\n### Requirement 1\n\nThe cache SHALL expire after 60 seconds.\n",
  background_nested_constraints:
    "# Spec\n\n## Background\n\nThe API is old.\n\n### Constraints\n\n- Never edit migrations/.\n- Do not change the public API.\n\n## Plan\n\n- Add a cache layer.\n",
  bold_context_rest_of_doc:
    "# Spec\n\n**Context**\n\nThe API is old.\n\nNever edit migrations/. Do not change the public API.\n\n- Add a cache layer.\n",
  nongoal_no_heading:
    "# Spec\n\nAdd a cache layer to the API.\n\nRate limiting is out of scope. We will not touch billing/.\n",
  modal_semicolon_lead_never: "Never write to prod; the job SHALL run nightly.",
  modal_semicolon_trail_never: "The job SHALL run nightly; never write to prod.",
  modal_should_never_and_must: "Agents should never touch billing/ and must keep tests green.",
  modal_comma_never: "The deploy MUST use the staging key, never the prod key.",
  modal_no_writes: "Workers SHALL retry failed jobs with no writes to billing/.",
  nongoals_nested_requirement:
    "# Spec\n\n## Non-goals\n\n- Rewriting the backend.\n\n### Requirement 2\n\nThe CLI SHALL print a summary.\n",
};

const BASE_OUT: Record<string, string[]> = {
  context_must_not: ["MUST NOT touch billing/ during this work"],
  intro_kiro: ["Do not modify the payments service"],
  background_nested_constraints: ["Never edit migrations/", "Do not change the public API"],
  bold_context_rest_of_doc: ["Never edit migrations/", "Do not change the public API"],
  nongoal_no_heading: [],
  modal_semicolon_lead_never: ["Never write to prod"],
  modal_semicolon_trail_never: ["never write to prod"],
  modal_should_never_and_must: ["never touch billing/ and must keep tests green"],
  modal_comma_never: ["never the prod key"],
  modal_no_writes: ["no writes to billing/"],
  nongoals_nested_requirement: [],
};

describe("every prohibition the base build kept is still kept", () => {
  for (const [name, text] of Object.entries(REVIEW_CASES)) {
    it(`${name}`, () => {
      const out = draftContract({ userText: text }).out_of_scope.map((item) => item.toLowerCase());
      for (const kept of BASE_OUT[name]) {
        expect(out).toContain(kept.toLowerCase());
      }
    });
  }

  it("nongoal_no_heading also routes the declared out-of-scope item", () => {
    const contract = draftContract({ userText: REVIEW_CASES.nongoal_no_heading });
    expect(contract.out_of_scope).toContain("Rate limiting");
  });

  it("nongoals_nested_requirement keeps the nested requirement in scope", () => {
    const contract = draftContract({ userText: REVIEW_CASES.nongoals_nested_requirement });
    expect(contract.out_of_scope).toContain("Rewriting the backend");
    expect(lower(contract.in_scope)).toContain("the cli shall print a summary");
    expect(lower(contract.out_of_scope)).not.toContain("print a summary");
  });
});

describe("plain prompts without markdown structure extract as before", () => {
  it("keeps the leading-prohibition and imperative split", () => {
    const contract = draft([
      "Update the readme usage docs. Do not change source. Done when one usage example is documented.",
    ]);
    expect(lower(contract.out_of_scope)).toContain("do not change source");
    expect(lower(contract.in_scope)).toContain("update the readme usage docs");
  });
});
