// Tests for the release-kind decision: given a pushed tag and the version
// every published package carries, is this a package release (publish
// everything) or an action-only release (publish nothing, move the tag, cut
// a Release)?
//
// Ported from vault-guard's scripts/tests/release-kind.test.mjs, itself
// ported from dep-guard's original two-package (core, cli) version,
// generalised here to intent-guard's four
// (intent-guard-schema, intent-guard-core, intent-guard-skill, intent-guard).
//
// Run through this repository's root vitest.config.ts, which includes
// "scripts/tests/**/*.test.mjs" alongside "examples/**/*.test.ts". Plain
// ESM, no build step ahead of it, matching how
// .github/workflows/release.yml runs scripts/classify-release-tag.mjs
// before "pnpm install".
//
// Everything here runs offline. The registry lookup is injected -- as a
// function at the library level, as an executable at the script level
// (IG_NPM_BIN) -- so no test in this file can pass or fail because of what
// npmjs.com happened to answer.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXACT_SEMVER,
  classifyRelease,
  compareExactSemver,
  parseExactSemver,
  readActionVersionDefault,
} from "../lib/release-kind.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "classify-release-tag.mjs");

const SCHEMA_NAME = "@vaultcompass/intent-guard-schema";
const CORE_NAME = "@vaultcompass/intent-guard-core";
const SKILL_NAME = "@vaultcompass/intent-guard-skill";
const CLI_NAME = "@vaultcompass/intent-guard";
const PACKAGE_NAMES = [SCHEMA_NAME, CORE_NAME, SKILL_NAME, CLI_NAME];

// The four packages at a single version, one of them optionally overridden
// by name -- used to build a lockstep break without repeating all four.
function packagesAt(version, overrides = {}) {
  return PACKAGE_NAMES.map((name) => ({ name, version: overrides[name] ?? version }));
}

// A stand-in action.yml whose description block deliberately contains the
// string "default:" and a version-shaped number in prose, the same trap the
// real file's version input description has (it names an example version
// and uses the word "default" in prose). A parser that just grepped for the
// first "default:" after "version:" would read the prose and be wrong in
// the direction that matters: it would compare the tag against a number
// nobody ships.
function actionYmlWith(defaultVersion) {
  return [
    "name: Intent Guard",
    "inputs:",
    "  version:",
    "    description: |",
    "      The exact version of `@vaultcompass/intent-guard` to install, such as",
    "      `1.5.0`. The default: below is the scanner version this action tag",
    "      shipped with.",
    "    required: false",
    `    default: ${defaultVersion}`,
    "  project:",
    "    description: Path to the Intent Guard project root",
    "    required: false",
    "    default: .",
    "runs:",
    "  using: composite",
    "",
  ].join("\n");
}

// A CHANGELOG.md in this repository's own style: "## [1.5.3] - 2026-09-20".
function changelogWith(...versions) {
  return [
    "# Changelog",
    "",
    ...versions.flatMap((version) => [`## [${version}] - 2026-09-20`, "", "- Something changed.", ""]),
  ].join("\n");
}

function registryStub(publishedSpecs) {
  const published = new Set(publishedSpecs);
  const calls = [];
  const lookup = (name, version) => {
    calls.push(`${name}@${version}`);
    return published.has(`${name}@${version}`) ? version : null;
  };
  lookup.calls = calls;
  return lookup;
}

// The happy action-only case, spelled out once: all four packages at 1.5.2
// and all four live on the registry at exactly that version, action.yml's
// default at 1.5.2, a CHANGELOG entry for 1.5.3, tag v1.5.3.
function actionOnlyInputs(overrides = {}) {
  return {
    tagName: "v1.5.3",
    refDescription: "tag v1.5.3",
    packages: packagesAt("1.5.2"),
    actionYmlText: actionYmlWith("1.5.2"),
    changelogText: changelogWith("1.5.3", "1.5.2"),
    publishedVersion: registryStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`)),
    ...overrides,
  };
}

describe("parseExactSemver", () => {
  it("accepts an exact three-part version with no leading zeros", () => {
    expect(parseExactSemver("1.5.2")).toEqual([1, 5, 2]);
    expect(parseExactSemver("10.20.30")).toEqual([10, 20, 30]);
  });

  it("rejects prerelease and build suffixes, leading zeros, and short forms", () => {
    for (const bad of ["1.5.3-rc.1", "1.5.3+build.5", "01.2.3", "1.5.03", "1.5", "v1.5.3", "", "latest"]) {
      expect(parseExactSemver(bad)).toBeNull();
    }
  });

  it("does not admit action.yml's dist-tag values, since a release tag is never one", () => {
    for (const distTag of ["latest", "next", "beta"]) {
      expect(EXACT_SEMVER.test(distTag)).toBe(false);
    }
  });
});

describe("compareExactSemver", () => {
  it("orders by number, not by string", () => {
    // The string comparison bash would have done reads "1.9.0" as greater
    // than "1.10.0". This is the one place that difference decides whether
    // a tag is a forward move or a mistake.
    expect(compareExactSemver([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([1, 5, 3], [1, 5, 2])).toBeGreaterThan(0);
    expect(compareExactSemver([1, 5, 2], [1, 5, 3])).toBeLessThan(0);
    expect(compareExactSemver([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0);
    expect(compareExactSemver([1, 5, 2], [1, 5, 2])).toBe(0);
  });
});

describe("readActionVersionDefault", () => {
  it("reads the version input default, not a version-shaped string in its prose", () => {
    expect(readActionVersionDefault(actionYmlWith("1.5.2"))).toBe("1.5.2");
  });

  it("is not confused by a later input that also has a default", () => {
    expect(readActionVersionDefault(actionYmlWith("1.2.3"))).toBe("1.2.3");
  });

  it("throws when there is no version input to read", () => {
    const yml = ["inputs:", "  project:", "    default: .", ""].join("\n");
    expect(() => readActionVersionDefault(yml)).toThrow(/version/i);
  });

  it("throws when the version input has no default", () => {
    const yml = ["inputs:", "  version:", "    required: true", "  project:", "    default: .", ""].join("\n");
    expect(() => readActionVersionDefault(yml)).toThrow(/default/i);
  });

  it("throws when there is no inputs block at all", () => {
    const yml = ["name: Intent Guard", "runs:", "  using: composite", ""].join("\n");
    expect(() => readActionVersionDefault(yml)).toThrow(/inputs/i);
  });

  it("reads the version input, not a same-named key in another top-level block", () => {
    // "version" is a plausible key outside inputs -- an outputs block is
    // the obvious one -- and putting it FIRST is what catches a reader that
    // takes the first "  version:" in the file. The number it would pick
    // up here is not what the action installs, so the check it feeds would
    // be comparing the tag against nothing meaningful.
    const yml = [
      "name: Intent Guard",
      "outputs:",
      "  version:",
      "    description: The version that ran",
      "    default: 9.9.9",
      "inputs:",
      "  version:",
      "    description: The version to install",
      "    required: false",
      "    default: 1.5.2",
      "runs:",
      "  using: composite",
      "",
    ].join("\n");
    expect(readActionVersionDefault(yml)).toBe("1.5.2");
  });

  it("throws rather than choosing when the version input has two defaults", () => {
    // YAML would resolve a duplicate key silently by taking the last one. A
    // release gate does not get to answer a question the file gives two
    // answers to.
    const yml = [
      "inputs:",
      "  version:",
      "    required: false",
      "    default: 1.5.2",
      "    default: 1.5.3",
      "  project:",
      "    default: .",
      "runs:",
      "  using: composite",
      "",
    ].join("\n");
    expect(() => readActionVersionDefault(yml)).toThrow(/two|2 `default:`|ambiguous/i);
  });

  it("reads the real action.yml and finds a default that matches the real package version", () => {
    const version = JSON.parse(
      readFileSync(path.join(ROOT, "packages", "cli", "package.json"), "utf8"),
    ).version;
    const real = readActionVersionDefault(readFileSync(path.join(ROOT, "action.yml"), "utf8"));
    expect(real).toBe(version);
  });
});

// The other half of that canary. The CHANGELOG condition is a pattern
// match against a heading style nothing enforces, so the way it breaks is
// silent: somebody reformats the headings, every test above keeps passing
// against its own synthetic changelog, and the next action-only tag is
// refused at tag time for a release that was perfectly fine. Reading the
// real file here moves that discovery to the pull request that reformats
// it.
describe("the real CHANGELOG.md", () => {
  it("carries a heading the action-only check can find for the current package version", () => {
    const version = JSON.parse(
      readFileSync(path.join(ROOT, "packages", "cli", "package.json"), "utf8"),
    ).version;
    const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

    const hasHeading = changelog.split("\n").some((line) => line.trim().startsWith(`## [${version}]`));
    expect(hasHeading).toBe(true);
  });
});

describe("classifyRelease", () => {
  it("requires at least one package", () => {
    expect(() =>
      classifyRelease({
        tagName: null,
        refDescription: "not a tag push",
        packages: [],
        actionYmlText: actionYmlWith("1.5.2"),
        changelogText: changelogWith("1.5.2"),
        publishedVersion: registryStub([]),
      }),
    ).toThrow(/at least one package/i);
  });

  it("calls a tag that equals v plus the package version a package release", () => {
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: "v1.5.2",
      refDescription: "tag v1.5.2",
      publishedVersion,
    });

    expect(result.actionOnly).toBe(false);
    expect(result.scannerVersion).toBe("1.5.2");
    // The package path must behave exactly as it did before this feature
    // existed, which includes touching the registry not at all: a package
    // release publishes a version that is by definition NOT on the
    // registry yet.
    expect(publishedVersion.calls).toEqual([]);
  });

  it("calls a greater tag with every package published and the action default in step an action-only release", () => {
    const inputs = actionOnlyInputs();
    const result = classifyRelease(inputs);

    expect(result.actionOnly).toBe(true);
    // The Release body names the scanner the tag installs; it is the
    // published package version, never the tag.
    expect(result.scannerVersion).toBe("1.5.2");
    expect([...inputs.publishedVersion.calls].sort()).toEqual(
      PACKAGE_NAMES.map((name) => `${name}@1.5.2`).sort(),
    );
  });

  it("fails when the tag is below the package version", () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "v1.5.1", refDescription: "tag v1.5.1" })),
    ).toThrow(/greater/i);
  });

  it("fails when the tag is numerically below the package version but above it as a string", () => {
    // 1.9.0 sorts after 1.10.0 as text. If the comparison were textual this
    // tag would be accepted as a forward move onto an older line.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: "v1.9.0",
          refDescription: "tag v1.9.0",
          packages: packagesAt("1.10.0"),
          actionYmlText: actionYmlWith("1.10.0"),
          publishedVersion: registryStub(PACKAGE_NAMES.map((name) => `${name}@1.10.0`)),
        }),
      ),
    ).toThrow(/greater/i);
  });

  it("fails on a tag with a prerelease suffix", () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "v1.5.3-rc.1", refDescription: "tag v1.5.3-rc.1" })),
    ).toThrow(/exact semver/i);
  });

  it("fails on a tag with a build suffix", () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "v1.5.3+build.5", refDescription: "tag v1.5.3+build.5" })),
    ).toThrow(/exact semver/i);
  });

  it("fails on a tag with a leading-zero component", () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "v1.05.3", refDescription: "tag v1.05.3" })),
    ).toThrow(/exact semver/i);
  });

  it("fails on a tag that does not begin with v", () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "1.5.3", refDescription: "tag 1.5.3" })),
    ).toThrow(/exact semver/i);
  });

  it("fails naming whichever package is not on the registry at the package version", () => {
    for (const missing of PACKAGE_NAMES) {
      const published = registryStub(
        PACKAGE_NAMES.filter((name) => name !== missing).map((name) => `${name}@1.5.2`),
      );
      expect(() => classifyRelease(actionOnlyInputs({ publishedVersion: published }))).toThrow(missing);
    }
  });

  it("fails when the registry answers with a different version than it was asked for", () => {
    const publishedVersion = () => "1.5.0";
    expect(() => classifyRelease(actionOnlyInputs({ publishedVersion }))).toThrow(/registry/i);
  });

  it("fails when action.yml's version default is not the package version", () => {
    // The tag is allowed to move without the scanner. The default is not:
    // an action-only tag ships the scanner that is already published, so a
    // moved default means the scanner changed and this is a package
    // release that forgot to bump its packages.
    expect(() =>
      classifyRelease(actionOnlyInputs({ actionYmlText: actionYmlWith("1.5.3") })),
    ).toThrow(/action\.yml/i);
  });

  it("fails a PACKAGE release whose action.yml default is not the version being published", () => {
    // The symmetric half of the action-only default check, and the one
    // that closes the split in the direction nobody chooses on purpose:
    // publishing 1.6.0 under tag v1.6.0 while the action that tag ships
    // still installs 1.5.2.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: "v1.6.0",
          refDescription: "tag v1.6.0",
          packages: packagesAt("1.6.0"),
          actionYmlText: actionYmlWith("1.5.2"),
        }),
      ),
    ).toThrow(/different scanner than it publishes/i);
  });

  it("accepts a package release whose action.yml default matches", () => {
    const result = classifyRelease(
      actionOnlyInputs({
        tagName: "v1.6.0",
        refDescription: "tag v1.6.0",
        packages: packagesAt("1.6.0"),
        actionYmlText: actionYmlWith("1.6.0"),
      }),
    );
    expect(result).toEqual({ actionOnly: false, scannerVersion: "1.6.0" });
  });

  it("skips the default check for a prerelease package version, which the action cannot be pinned to", () => {
    // action.yml refuses a prerelease pin outright, so there is no value
    // its default could carry that would equal 1.6.0-rc.1. Requiring one
    // would make a prerelease package release impossible rather than safe.
    const result = classifyRelease(
      actionOnlyInputs({
        tagName: "v1.6.0-rc.1",
        refDescription: "tag v1.6.0-rc.1",
        packages: packagesAt("1.6.0-rc.1"),
        actionYmlText: actionYmlWith("1.5.2"),
      }),
    );
    expect(result).toEqual({ actionOnly: false, scannerVersion: "1.6.0-rc.1" });
  });

  it("checks the action.yml default when there is no tag to classify", () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: null,
          refDescription: "not a tag push",
          actionYmlText: actionYmlWith("1.4.0"),
        }),
      ),
    ).toThrow(/different scanner than it publishes/i);
  });

  it("fails an action-only tag with no CHANGELOG entry for its version", () => {
    // The stray-tag case every other condition lets through: packages left
    // at 1.5.2 and "v1.5.3" pushed in the belief that they had moved. Exact
    // semver, greater, published, default in step -- and nobody wrote it
    // down, because nobody decided to release it.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          changelogText: changelogWith("1.5.2"),
        }),
      ),
    ).toThrow(/CHANGELOG\.md/);
  });

  it("accepts an action-only tag whose version has a CHANGELOG entry", () => {
    const result = classifyRelease(actionOnlyInputs());
    expect(result.actionOnly).toBe(true);
  });

  it("fails an action-only tag when CHANGELOG.md could not be read at all", () => {
    expect(() => classifyRelease(actionOnlyInputs({ changelogText: null }))).toThrow(/CHANGELOG\.md/);
  });

  it("checks the CHANGELOG before it touches the registry", () => {
    // Local, on the tagged commit's own tree, and free. A stray tag should
    // not cost a registry round trip to reject.
    const publishedVersion = registryStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          changelogText: changelogWith("1.5.2"),
          publishedVersion,
        }),
      ),
    ).toThrow(/CHANGELOG\.md/);
    expect(publishedVersion.calls).toEqual([]);
  });

  it("fails when packages disagree, before anything else is considered", () => {
    const publishedVersion = registryStub([]);
    expect(() =>
      classifyRelease(
        actionOnlyInputs({ packages: packagesAt("1.5.2", { [CLI_NAME]: "1.5.1" }), publishedVersion }),
      ),
    ).toThrow(/lockstep/i);
    expect(publishedVersion.calls).toEqual([]);
  });

  it("never consults the registry when there is no tag at all", () => {
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: null,
      refDescription: "not a tag push",
      publishedVersion,
    });
    expect(result.actionOnly).toBe(false);
    expect(publishedVersion.calls).toEqual([]);

    expect(() =>
      classifyRelease({
        ...actionOnlyInputs(),
        tagName: null,
        refDescription: "not a tag push",
        packages: packagesAt("1.5.2", { [CLI_NAME]: "1.5.1" }),
      }),
    ).toThrow(/lockstep/i);
  });

  it("fails legibly when the package version itself is not exact semver and the tag differs", () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          packages: packagesAt("1.5.2-rc.1"),
          actionYmlText: actionYmlWith("1.5.2"),
        }),
      ),
    ).toThrow(/package version/i);
  });

  it("names the ref in every failure message", () => {
    // The whole point of failing here rather than at publish time is that
    // a human reads the message at tag time. A message that does not name
    // the tag makes them go look it up.
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: "v1.5.1", refDescription: "tag v1.5.1" })),
    ).toThrow(/tag v1\.5\.1/);
  });
});

// The workflow half. The library above can be perfectly correct while
// .github/workflows/release.yml ignores its answer, and the failure that
// would produce is the expensive one: a publish on a tag that was supposed
// to publish nothing, or a Release page announcing a publish that did not
// happen. Nothing here re-tests the decision -- it tests that the decision
// is wired to the steps it is supposed to govern.
//
// Textual rather than through a YAML parser on purpose: this repository has
// no YAML dependency in scripts/, and the release job's decision step runs
// before `pnpm install` precisely so it depends on nothing.
describe(".github/workflows/release.yml wiring", () => {
  // IG_RELEASE_WORKFLOW points this suite at a mutated copy, the same idea
  // as IG_NPM_BIN for the registry: a guard nobody has watched fail is a
  // guard nobody knows works. Used to confirm that dropping the gate from
  // "Publish to npm" turns this file red, which is not something that can
  // be tried on the real file.
  const workflow = readFileSync(
    process.env.IG_RELEASE_WORKFLOW ?? path.join(ROOT, ".github", "workflows", "release.yml"),
    "utf8",
  );
  // Spelled positively, and asserted as this exact string. "!= 'true'" is
  // the same thing right up until the output is empty or missing, at which
  // point it publishes on a run that decided nothing.
  const GATE = "steps.kind.outputs.action_only == 'false'";

  // The release job's steps sit at six spaces in this file (jobs.release
  // itself is nested one level deeper than in the sibling repositories'
  // examples this was ported from).
  //
  // A step is identified by its name, or by "uses:<value>" when it has no
  // name -- a step written "- uses: actions/checkout@v4" with no name is
  // valid YAML and perfectly ordinary, and a parser that only knew
  // "- name:" would not see it at all. That blindness is exactly what an
  // exact-list assertion must not have: an unnamed publish-side step would
  // then be invisible to every check below rather than caught by them.
  function parseSteps(text) {
    const lines = text.split("\n");
    const steps = [];
    let current = null;
    for (const line of lines) {
      const nameMatch = /^ {6}- name: (.*)$/.exec(line);
      const usesMatch = /^ {6}- uses: (.*)$/.exec(line);
      if (nameMatch !== null || usesMatch !== null) {
        current = {
          name: nameMatch === null ? null : nameMatch[1].trim(),
          uses: usesMatch === null ? null : usesMatch[1].trim(),
          if: null,
        };
        current.id = current.name ?? `uses:${current.uses}`;
        steps.push(current);
        continue;
      }
      if (current !== null) {
        const ifMatch = /^ {8}if: (.*)$/.exec(line);
        if (ifMatch !== null) {
          current.if = ifMatch[1].trim();
        }
        const usesLater = /^ {8}uses: (.*)$/.exec(line);
        if (usesLater !== null && current.uses === null) {
          current.uses = usesLater[1].trim();
        }
        if (/^ {4}\S/.test(line)) {
          current = null;
        }
      }
    }
    return steps;
  }

  // Only the "release" job's own text: its steps and the smoke-published
  // job's steps sit at the SAME indentation (each job's own "steps:" list
  // starts a fresh nesting level from that job's "name:"/"needs:" block),
  // so parseSteps cannot tell them apart by indentation alone. Cutting the
  // text at the next top-level job key is what keeps this suite reading
  // only the job it claims to.
  const releaseJobText = workflow.slice(0, workflow.indexOf("\n  smoke-published:"));
  const releaseJobSteps = () => parseSteps(releaseJobText);

  // Every step that exists to protect or perform a publish. The code gates
  // (install, build, the portfolio-name guard, test, release smoke) are NOT
  // here: they run on both kinds of release, because this workflow never
  // learns whether they already ran on the exact commit that got tagged,
  // and an action-only release's payload is exactly what those gates cover.
  const GATED_STEPS = ["Publish to npm"];

  // Every step before the decision, in order.
  const STEPS_BEFORE_DECISION = [
    "uses:actions/checkout@v4",
    "uses:pnpm/action-setup@v4",
    "uses:actions/setup-node@v4",
    "Assert the tagged commit is on main",
  ];

  // Every step from the decision to the end of the release job, gated or
  // not, in order. The set assertion below cannot see a NEW ungated step --
  // that is what this list is for: inserting anything after the decision,
  // named or unnamed, fails until somebody states which side of the gate it
  // belongs on.
  const STEPS_AFTER_DECISION = [
    "Install",
    "Build",
    "Portfolio name guard",
    "Test",
    "Release smoke",
    ...GATED_STEPS,
    "Create GitHub Release",
    "Create GitHub Release (action-only)",
  ];

  it("gates exactly the publish-side steps on the decision step output", () => {
    const gated = releaseJobSteps()
      .filter((step) => step.if === GATE)
      .map((step) => step.id);
    // "Create GitHub Release" carries the same gate and is asserted
    // separately below, with the body claim it guards.
    expect(gated.sort()).toEqual([...GATED_STEPS, "Create GitHub Release"].sort());
  });

  it("runs the code gates on both kinds of release", () => {
    const ungated = ["Install", "Build", "Portfolio name guard", "Test", "Release smoke"];
    for (const name of ungated) {
      const step = releaseJobSteps().find((s) => s.id === name);
      expect(step).toBeDefined();
      expect(step.if).toBeNull();
    }
  });

  it("accounts for every step after the decision, to the end of the job, in order", () => {
    const ids = releaseJobSteps().map((step) => step.id);
    const from = ids.indexOf("Decide the release kind, and refuse a tag that is neither");
    expect(from).toBeGreaterThan(-1);
    expect(ids.slice(from + 1)).toEqual(STEPS_AFTER_DECISION);
  });

  it("accounts for every step in the whole release job, from checkout onward, in order", () => {
    const ids = releaseJobSteps().map((step) => step.id);
    expect(ids).toEqual([
      ...STEPS_BEFORE_DECISION,
      "Decide the release kind, and refuse a tag that is neither",
      ...STEPS_AFTER_DECISION,
    ]);
  });

  it("keeps the ancestry-on-main check as its own step, ahead of the decision", () => {
    // This repository's existing backstop, kept rather than folded into the
    // decision step: it already ran before this port, and the port's job
    // is to wire a classifier in, not to restructure a working guard.
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("Refusing to publish");
  });

  it("claims a publish only on the path that performs one", () => {
    // "Published ... to npm" must live in exactly one Release body, and
    // that body's step must carry the same gate as the publish step. An
    // action-only release that announced a publish would be sending people
    // to look for a version that does not exist.
    const publishClaims = workflow.match(/Published @vaultcompass\/intent-guard packages to npm/g) ?? [];
    expect(publishClaims).toHaveLength(1);

    const release = releaseJobSteps().find((step) => step.id === "Create GitHub Release");
    expect(release.if).toBe(GATE);

    const actionOnlyRelease = releaseJobSteps().find(
      (step) => step.id === "Create GitHub Release (action-only)",
    );
    expect(actionOnlyRelease.if).toBe("steps.kind.outputs.action_only == 'true'");
    expect(workflow).toContain("Nothing was published to npm by this release.");
  });

  it("skips the published-CLI smoke job when nothing was published", () => {
    // Positive spelling here too: an empty output means no run decided
    // anything, and the smoke job's whole premise is that a publish
    // happened.
    expect(workflow).toContain("if: needs.release.outputs.action_only == 'false'");
    expect(workflow).toContain("action_only: ${{ steps.kind.outputs.action_only }}");
  });

  it("never gates anything on the negative spelling", () => {
    // The one assertion that would catch a well-meaning edit back to
    // "!= 'true'", which reads identically and fails open.
    expect(workflow).not.toContain("action_only != 'true'");
    expect(workflow).not.toContain("action_only != 'false'");
  });

  it("passes the changelog to the decision script", () => {
    const invocations = workflow.match(/node scripts\/classify-release-tag\.mjs/g) ?? [];
    expect(invocations).toHaveLength(1);
    const changelogArgs = workflow.match(/--changelog CHANGELOG\.md/g) ?? [];
    expect(changelogArgs).toHaveLength(1);
  });

  it("passes all four published packages to the decision script", () => {
    for (const dir of ["schema", "core", "skill", "cli"]) {
      expect(workflow).toContain(`require('./packages/${dir}/package.json').name`);
      expect(workflow).toContain(`require('./packages/${dir}/package.json').version`);
    }
    const packageFlags = workflow.match(/--package "/g) ?? [];
    expect(packageFlags).toHaveLength(4);
  });

  it("keeps the decision step and the \"Publish to npm\" loop in the same set of packages", () => {
    // The decision step reads each package.json by a literal path (see the
    // test above); "Publish to npm" has to loop shell-side instead, over
    // its own "for pkg in ..." list, so nothing keeps the two lists in
    // agreement automatically. Adding a fifth published package to one and
    // not the other -- a real way for these to drift apart -- is exactly
    // what this catches.
    const decisionDirs = [
      ...workflow.matchAll(/require\('\.\/packages\/([a-z0-9_-]+)\/package\.json'\)\.name/g),
    ].map((match) => match[1]);
    expect(decisionDirs.length).toBeGreaterThan(0);

    const forPkgMatch = workflow.match(/for pkg in ([^;]+); do/);
    expect(forPkgMatch).not.toBeNull();
    const publishDirs = forPkgMatch[1]
      .trim()
      .split(/\s+/)
      .map((dir) => dir.replace(/^packages\//, ""));

    expect(new Set(publishDirs)).toEqual(new Set(decisionDirs));
  });

  it("calls the decision script from a step with the id the conditions read", () => {
    expect(workflow).toMatch(/^ {6}- name: Decide the release kind[^\n]*\n {8}id: kind$/m);
    expect(workflow).toContain("node scripts/classify-release-tag.mjs");
  });

  it("runs the decision step before install, build, test and publish", () => {
    const ids = releaseJobSteps().map((step) => step.id);
    const decisionAt = ids.indexOf("Decide the release kind, and refuse a tag that is neither");
    const installAt = ids.indexOf("Install");
    const publishAt = ids.indexOf("Publish to npm");
    expect(decisionAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(decisionAt);
    expect(publishAt).toBeGreaterThan(decisionAt);
  });
});

// The script half: argument handling, the real spawn of an npm-shaped
// executable, and the GITHUB_OUTPUT contract the workflow's later steps
// read. IG_NPM_BIN points at a stub here, so this never reaches the
// network -- and the stub records what it was asked, so "the package path
// does not consult the registry" is proven against the real spawn path and
// not only against the injected function above.
describe("classify-release-tag.mjs", () => {
  function makeNpmStub(publishedSpecs) {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-npm-stub-"));
    const bin = path.join(dir, "npm-stub.mjs");
    const log = path.join(dir, "calls.log");
    const source = [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `const published = ${JSON.stringify(publishedSpecs)};`,
      // Logs the working directory it was started in as well as its
      // arguments: where npm runs decides which .npmrc it reads, and that
      // decides what "already published" means.
      `appendFileSync(${JSON.stringify(log)}, 'cwd=' + process.cwd() + ' argv=' + process.argv.slice(2).join(' ') + '\\n');`,
      "const spec = process.argv[3] ?? '';",
      "if (!published.includes(spec)) {",
      "  process.stderr.write('npm error code E404\\n');",
      "  process.exit(1);",
      "}",
      "process.stdout.write(spec.slice(spec.lastIndexOf('@') + 1) + '\\n');",
      "",
    ].join("\n");
    writeFileSync(bin, source);
    chmodSync(bin, 0o755);
    writeFileSync(log, "");
    return { bin, log, dir };
  }

  function run(args, env) {
    const outFile = path.join(mkdtempSync(path.join(tmpdir(), "ig-gh-out-")), "output.txt");
    writeFileSync(outFile, "");
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
    });
    return { ...result, outputs: readFileSync(outFile, "utf8") };
  }

  const baseArgs = (tag) => [
    ...(tag === null ? [] : ["--tag", tag]),
    "--package",
    `${SCHEMA_NAME}=1.5.2`,
    "--package",
    `${CORE_NAME}=1.5.2`,
    "--package",
    `${SKILL_NAME}=1.5.2`,
    "--package",
    `${CLI_NAME}=1.5.2`,
  ];

  function withActionYml(defaultVersion) {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-action-yml-"));
    const file = path.join(dir, "action.yml");
    writeFileSync(file, actionYmlWith(defaultVersion));
    return file;
  }

  function withChangelog(...versions) {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-changelog-"));
    const file = path.join(dir, "CHANGELOG.md");
    writeFileSync(file, changelogWith(...versions));
    return file;
  }

  // The files every case below needs unless it is testing one of them: an
  // action.yml whose default matches the package version, and a CHANGELOG
  // carrying an entry for the action-only tag these tests push.
  const files = (actionDefault = "1.5.2", changelogVersions = ["1.5.3", "1.5.2"]) => [
    "--action-yml",
    withActionYml(actionDefault),
    "--changelog",
    withChangelog(...changelogVersions),
  ];

  it("reports action_only=true and the scanner version for a valid action-only tag", () => {
    const stub = makeNpmStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    const result = run([...baseArgs("v1.5.3"), ...files()], {
      IG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain("action_only=true");
    expect(result.outputs).toContain("scanner_version=1.5.2");
    expect(readFileSync(stub.log, "utf8")).toContain(`view ${SCHEMA_NAME}@1.5.2 version`);
  });

  it("asks the public registry, from a directory this repository does not control", () => {
    // npm reads .npmrc from its working directory upward, so running the
    // lookup at the repository root would let a checked-in or generated
    // .npmrc decide what "already published" means -- the one question
    // standing between a tag and a Release page claiming a published
    // version. Hence a temp directory, and an explicit --registry.
    const stub = makeNpmStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    const result = run([...baseArgs("v1.5.3"), ...files()], { IG_NPM_BIN: stub.bin });
    expect(result.status).toBe(0);

    const log = readFileSync(stub.log, "utf8");
    const cwds = [...log.matchAll(/^cwd=(.*?) argv=/gm)].map((m) => m[1]);
    expect(cwds.length).toBeGreaterThan(0);
    for (const cwd of cwds) {
      expect(cwd).not.toBe(ROOT);
      expect(cwd.startsWith(ROOT)).toBe(false);
    }
    expect(log).toContain("--registry=https://registry.npmjs.org");
  });

  it("runs the lookup in RUNNER_TEMP when the runner provides one", () => {
    const runnerTemp = mkdtempSync(path.join(tmpdir(), "ig-runner-temp-"));
    const stub = makeNpmStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    const result = run([...baseArgs("v1.5.3"), ...files()], {
      IG_NPM_BIN: stub.bin,
      RUNNER_TEMP: runnerTemp,
    });

    expect(result.status).toBe(0);
    // realpath: the OS temp dir resolves through a symlink on macOS, so the
    // child reports the resolved path for the value handed in here.
    expect(readFileSync(stub.log, "utf8")).toContain(`cwd=${realpathSync(runnerTemp)} `);
  });

  it("refuses an action-only tag whose version has no CHANGELOG entry", () => {
    const stub = makeNpmStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    const result = run([...baseArgs("v1.5.3"), ...files("1.5.2", ["1.5.2"])], {
      IG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("CHANGELOG.md");
    expect(result.outputs).not.toContain("action_only=true");
  });

  it("reports action_only=false for a package-release tag and never runs npm, and the publish step is skipped", () => {
    // This is the case the port exists for: a package-version tag stays a
    // normal release, action_only=false, and "Publish to npm" runs.
    const stub = makeNpmStub([]);
    const result = run([...baseArgs("v1.5.2"), ...files()], {
      IG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain("action_only=false");
    expect(readFileSync(stub.log, "utf8")).toBe("");
  });

  it("reports action_only=true for an action-only tag, which is what skips the publish step and the smoke-published job", () => {
    const stub = makeNpmStub(PACKAGE_NAMES.map((name) => `${name}@1.5.2`));
    const result = run([...baseArgs("v1.5.3"), ...files()], {
      IG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain("action_only=true");
    expect(result.outputs).not.toContain("action_only=false");
  });

  it("refuses a package-release tag whose action.yml default is a different version", () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs("v1.5.2"), ...files("1.4.0")], { IG_NPM_BIN: stub.bin });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("different scanner than it publishes");
    expect(readFileSync(stub.log, "utf8")).toBe("");
  });

  it("exits 1 with a workflow error annotation when the packages are not published", () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs("v1.5.3"), ...files()], {
      IG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("::error::");
    expect(result.stdout + result.stderr).toContain(SCHEMA_NAME);
    expect(result.outputs).not.toContain("action_only=true");
  });

  it("exits 1 when no --package is given", () => {
    const result = run(["--tag", "v1.5.3"], {});
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/--package/);
  });

  it("exits 1 when a --package value is not name=version", () => {
    const result = run(["--tag", "v1.5.3", "--package", "not-a-valid-value"], {});
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/name=version/);
  });

  it("treats an npm lookup that fails for any reason as not published", () => {
    // Fail closed. A registry outage blocks an action-only tag; it must
    // never be read as "published, go ahead".
    const dir = mkdtempSync(path.join(tmpdir(), "ig-npm-broken-"));
    const bin = path.join(dir, "npm-broken");
    writeFileSync(bin, "#!/bin/sh\nexit 7\n");
    chmodSync(bin, 0o755);

    const result = run([...baseArgs("v1.5.3"), ...files()], {
      IG_NPM_BIN: bin,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("::error::");
  });
});
