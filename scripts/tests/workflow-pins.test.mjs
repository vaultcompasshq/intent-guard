// Every action a workflow or the composite action runs is pinned by full
// commit SHA, with the release it stands for in a trailing comment.
//
// The 2026-10-28 supply-chain audit's B1: release.yml ran
// softprops/action-gh-release@v2 inside the job that holds id-token: write,
// and pnpm/action-setup@v6 in the job that packs the tarballs. A tag can be
// moved by whoever controls that repository, and code at the moved tag runs
// with this job's token. A SHA cannot be moved.
//
// The files are parsed as YAML, so every spelling of the key counts: extra
// spaces or a tab after the dash, "uses :", a quoted key, a flow mapping
// (the review of 44e4cd7, N1). Every `uses` value found under jobs.*,
// jobs.*.steps[*] and runs.steps[*] must be a local "./" action, a
// docker:// image pinned by sha256 digest, or owner/repo[/path]@<40 hex>
// with "# v<version>" after it on its line. This checks the shape of a pin,
// not that the SHA is the release the comment names.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

const FILES = [
  ...readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(".github", "workflows", name)),
  "action.yml",
];

const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `uses` value in a parsed workflow or composite action. */
function usesValues(doc) {
  const out = [];
  const fromSteps = (steps) => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (step && typeof step === "object" && "uses" in step) out.push(step.uses);
    }
  };
  if (doc && typeof doc === "object") {
    for (const job of Object.values(doc.jobs ?? {})) {
      if (job && typeof job === "object") {
        if ("uses" in job) out.push(job.uses);
        fromSteps(job.steps);
      }
    }
    fromSteps(doc.runs?.steps);
  }
  return out;
}

/** Every `uses` in `text` that is not pinned by SHA with a version comment. */
export function unpinnedUses(text) {
  const values = usesValues(parse(text));
  return values
    .filter((value) => {
      if (typeof value !== "string") return true;
      if (value.startsWith("./")) return false;
      if (DOCKER_DIGEST.test(value)) return false;
      if (!SHA_REF.test(value)) return true;
      // The version comment sits on the same line as the SHA.
      return !new RegExp(`${escapeRegExp(value)}["']?\\s+#\\s+v\\d+(?:\\.\\d+){0,2}\\s*$`, "m").test(text);
    })
    .map(String);
}

const SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const steps = (...lines) => ["jobs:", "  a:", "    steps:", ...lines].join("\n");

describe("every action is pinned by commit SHA", () => {
  it("finds the workflow files it checks", () => {
    expect(FILES).toContain(path.join(".github", "workflows", "release.yml"));
    expect(FILES).toContain(path.join(".github", "workflows", "ci.yml"));
  });

  for (const file of FILES) {
    it(`${file} has no action pinned by tag or branch`, () => {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(usesValues(parse(text)).length).toBeGreaterThan(0);
      expect(unpinnedUses(text)).toEqual([]);
    });
  }

  it("goes red on a tag, a short SHA, a SHA with no version comment, and a branch", () => {
    expect(unpinnedUses(steps("      - uses: softprops/action-gh-release@v2"))).toHaveLength(1);
    expect(unpinnedUses(steps("      - uses: pnpm/action-setup@ea17c68 # v6.1.0"))).toHaveLength(1);
    expect(unpinnedUses(steps(`      - uses: actions/checkout@${SHA}`))).toHaveLength(1);
    expect(unpinnedUses(steps("      - uses: actions/checkout@main"))).toHaveLength(1);
    expect(unpinnedUses(steps(`      - uses: actions/checkout@${SHA} # v7.0.0`))).toEqual([]);
  });

  it("goes red on every YAML spelling of a tag pin", () => {
    const spellings = [
      // A tab after the dash is not valid YAML here: the parser throws, which
      // fails the file's own test rather than passing it.
      "      -   uses: x/y@v2",
      "      - uses : x/y@v2",
      '      - "uses": x/y@v2',
      "      - 'uses': x/y@v2",
      "      - { uses: x/y@v2 }",
      "      - ? uses\n        : x/y@v2",
      '      - uses: "x/y@v2"',
    ];
    for (const line of spellings) {
      expect({ line, found: unpinnedUses(steps(line)) }).toEqual({ line, found: ["x/y@v2"] });
    }
  });

  it("goes red on a reusable workflow, a composite action step, and an unpinned docker image", () => {
    expect(unpinnedUses("jobs:\n  a:\n    uses: o/r/.github/workflows/w.yml@main\n")).toHaveLength(1);
    expect(unpinnedUses("runs:\n  using: composite\n  steps:\n    - uses: x/y@v2\n")).toHaveLength(1);
    expect(unpinnedUses(steps("      - uses: docker://alpine:3"))).toHaveLength(1);
    expect(unpinnedUses(steps("      - uses: ./local-action"))).toEqual([]);
  });
});
