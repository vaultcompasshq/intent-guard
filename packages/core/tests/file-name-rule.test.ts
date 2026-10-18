import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { scoreDrift } from "../src/drift.js";
import { namesChangedFile, stripEmphasis } from "../src/tokenize.js";

// The closed file-name rule reads the words of a rule as written. A rule
// written in markdown wraps the name in emphasis, backticks or quotes and
// ends the sentence with punctuation; each of those must reduce to the bare
// name before the comparison, or a rule that blocked in 1.9.0 passes.

function contractWith(outOfScope: string[]): IntentContract {
  return {
    contract_id: "ic-20261018-cccccc",
    version: "1.0.0",
    original_ask: "Add a theme toggle to the settings page.",
    in_scope: ["Theme toggle on the settings page"],
    out_of_scope: outOfScope,
    constraints: [],
    acceptance_criteria: [{ id: "ac-1", description: "Toggle switches the theme", testable: true }],
    frozen_at: "2026-10-18T00:00:00Z",
    pivot_log: [],
  };
}

describe("the closed file-name rule reads markdown-wrapped and punctuated names", () => {
  it.each([
    ["Never touch `Dockerfile`.", "Dockerfile"],
    ["Do not edit `CHANGELOG.md`.", "CHANGELOG.md"],
    ['Do not edit "Makefile".', "Makefile"],
    ["Do not edit 'Makefile'.", "Makefile"],
    ["Never commit `.env`.", ".env.local"],
    ["Do not modify `PaymentProcessor`.", "src/PaymentProcessor.ts"],
    ["Never touch **Dockerfile**", "Dockerfile"],
    ["Never touch **`Dockerfile`**", "Dockerfile"],
    ["Never touch **Dockerfile**.", "Dockerfile"],
    ["Never touch _Dockerfile_, ever", "Dockerfile"],
  ])("names the file: %s against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it.each([
    ['Do not edit **"Makefile"**', "Makefile"],
    ["Never touch **(Dockerfile)**", "Dockerfile"],
  ])("reduces until the word stops changing: %s against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it.each([
    ["Never modify **payment**_methods", "db/payment_methods.sql"],
    ["Never modify payment_*methods*", "db/payment_methods.sql"],
    ["Never modify _payment_methods_", "db/payment_methods.sql"],
  ])("strips emphasis inside an identifier: %s against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it("never strips an underscore that is part of an identifier", () => {
    expect(namesChangedFile("Never touch payment_method_ids", ["db/payment_method_ids.sql"])).toBe(true);
    expect(namesChangedFile("Never touch payment_method_ids.", ["db/payment_method_ids.sql"])).toBe(true);
    expect(namesChangedFile("Never touch paymentmethodids", ["db/payment_method_ids.sql"])).toBe(false);
  });

  it("still names a dunder file whose underscores look like emphasis", () => {
    expect(namesChangedFile("Never edit __init__.py", ["pkg/__init__.py"])).toBe(true);
  });

  it("stays closed: case-sensitive, no substring, no other extension", () => {
    expect(namesChangedFile("Never touch **dockerfile**.", ["Dockerfile"])).toBe(false);
    expect(namesChangedFile("Never touch **Docker**.", ["Dockerfile"])).toBe(false);
    expect(namesChangedFile("Never touch `schema`.", ["prisma/schema.prisma.bak"])).toBe(false);
  });

  it.each([
    ["Never touch `Dockerfile`.", "Dockerfile"],
    ["Do not edit **CHANGELOG.md**.", "CHANGELOG.md"],
    ["Do not modify **payment**_methods.", "db/payment_methods.sql"],
  ])("counts the match in drift, not as file name only: %s against %s", (rule, path) => {
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });
});

// Each blocked in 1.9.0 and passed in 1.10.0 and on the first fix round
// (the 2026-10-18 review's probes): a leading ./ or /, a markdown link, braces,
// emphasis around a glob, and a slash path ending a sentence.
describe("the closed file-name rule reads paths, links, braces and globs as 1.9.0 did", () => {
  it.each([
    ["Never touch ./Dockerfile", "Dockerfile"],
    ["Never touch ./Dockerfile", "src/Dockerfile"],
    ["Never touch /Dockerfile", "Dockerfile"],
    ["Do not edit ./CHANGELOG.md", "CHANGELOG.md"],
    ["Do not edit `./CHANGELOG.md`.", "CHANGELOG.md"],
    ["Never touch `./.env.local`", ".env.local"],
    ["Never touch [Dockerfile](Dockerfile)", "Dockerfile"],
    ["Never touch [the Dockerfile](./Dockerfile)", "Dockerfile"],
    ["Do not edit [CHANGELOG.md](./CHANGELOG.md)", "CHANGELOG.md"],
    ["Do not edit the [changelog](CHANGELOG.md).", "CHANGELOG.md"],
    ["Never touch {Dockerfile}", "Dockerfile"],
    ["Never commit *.pem*", "certs/server.pem"],
    ["Never touch src/Dockerfile.", "src/Dockerfile"],
    ["Never edit config/.env.local.", "config/.env.local"],
    // Third round: backslash paths, a reference-style link, and footnote or
    // note markers.
    ["Never touch src\\Dockerfile", "src/Dockerfile"],
    ["Never touch .\\Dockerfile", "Dockerfile"],
    ["Never touch ..\\Dockerfile", "Dockerfile"],
    ["Never edit [CHANGELOG.md][1]", "CHANGELOG.md"],
    ["Never edit Dockerfile[^1]", "Dockerfile"],
    ["Never edit Dockerfile[1].", "Dockerfile"],
  ])("blocks: %s against %s", (rule, path) => {
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });

  it.each([
    ["Never touch Dockerfile: it is shared", "Dockerfile"],
    ["Never touch **Dockerfile**, ever", "Dockerfile"],
    ["Never edit __init__.py", "pkg/init.py"],
    ["Never touch [the docs](docs/guide.md)", "Dockerfile"],
    // Ruled 2026-10-18: a home-directory path is outside the repository, so
    // it names no file here, although 1.9.0 blocked it through its token.
    ["Never touch ~/Dockerfile", "Dockerfile"],
    // A reference label is not a name: the link text stays case-sensitive.
    ["Never edit the [changelog][log].", "CHANGELOG.md"],
  ])("stays a pass, as in 1.9.0 or closed by rule: %s against %s", (rule, path) => {
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBe(0);
    expect(result.action).toBe("proceed");
  });

  // The drift cases above can also block through the slash-fragment path;
  // these pin the closed rule's own reading of each form.
  it.each([
    ["Never touch ./Dockerfile", "src/Dockerfile"],
    ["Do not edit `./CHANGELOG.md`.", "CHANGELOG.md"],
    ["Never touch `./.env.local`", ".env.local"],
    ["Never touch [Dockerfile](Dockerfile)", "Dockerfile"],
    ["Never touch [the Dockerfile](./Dockerfile)", "Dockerfile"],
    ["Do not edit the [changelog](CHANGELOG.md).", "CHANGELOG.md"],
    ["Never touch {Dockerfile}", "Dockerfile"],
    ["Never commit *.pem*", "certs/server.pem"],
    ["Never touch .\\Dockerfile", "Dockerfile"],
    ["Never touch ..\\Dockerfile", "Dockerfile"],
    ["Never touch ../Dockerfile", "Dockerfile"],
    ["Never edit [CHANGELOG.md][1]", "CHANGELOG.md"],
    ["Never edit Dockerfile[^1]", "Dockerfile"],
    ["Never edit Dockerfile[1].", "Dockerfile"],
  ])("namesChangedFile reads %s as naming %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it("keeps a dunder name whole rather than reading its underscores as emphasis", () => {
    expect(namesChangedFile("Never edit __init__.py", ["pkg/init.py"])).toBe(false);
    expect(namesChangedFile("Never edit __init__.py", ["pkg/__init__.py"])).toBe(true);
    expect(namesChangedFile("Never edit **__init__.py**", ["pkg/__init__.py"])).toBe(true);
  });
});

describe("emphasis is only ever paired markers on a word boundary", () => {
  // Every earlier underscore test used an identifier with one underscore, so
  // dropping the boundary check in EMPHASIS_RE left them green while
  // "_method_" inside payment_method_ids was read as emphasis.
  it("leaves an identifier with two underscores whole", () => {
    expect(stripEmphasis("payment_method_ids")).toBe("payment_method_ids");
    expect(stripEmphasis("Never touch the payment_method_ids table")).toBe(
      "Never touch the payment_method_ids table",
    );
  });

  it("still blocks a rule naming a two-underscore directory", () => {
    const result = scoreDrift(contractWith(["Never touch the payment_method_ids table"]), {
      changedPaths: ["db/payment_method_ids/x.sql"],
    });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });
});
