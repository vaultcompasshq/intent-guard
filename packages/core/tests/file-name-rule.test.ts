import { describe, it, expect } from "vitest";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { scoreDrift } from "../src/drift.js";
import { mentionsChangedBasename, namesChangedFile, stripEmphasis } from "../src/tokenize.js";

// Non-ASCII characters are built from code points, so this file stays ASCII
// and an invisible one (a zero-width space, a soft hyphen) is visible here.
const cp = (...points: number[]): string => String.fromCodePoint(...points);

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

  // 1.10.1 kept a dunder whole and never read init.py from __init__.py.
  // That guard also kept __Makefile__ (bold) from naming Makefile, a
  // block-to-pass against 1.9.0 (2026-10-27 B1), so both readings are kept
  // and __init__.py names pkg/init.py again, as its init token did in 1.9.0.
  it("keeps a dunder name whole and also reads its underscores as emphasis", () => {
    expect(namesChangedFile("Never edit __init__.py", ["pkg/__init__.py"])).toBe(true);
    expect(namesChangedFile("Never edit **__init__.py**", ["pkg/__init__.py"])).toBe(true);
    expect(namesChangedFile("Do not edit __Makefile__.", ["Makefile"])).toBe(true);
    const result = scoreDrift(contractWith(["Never edit __init__.py"]), { changedPaths: ["pkg/init.py"] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
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

  // Without the lookbehind, the underscore inside old_payment_ opened an
  // emphasis pair that the trailing underscore closed (2026-10-27 N4a).
  it("leaves an identifier with a trailing underscore segment whole", () => {
    expect(stripEmphasis("Never touch old_payment_")).toBe("Never touch old_payment_");
    expect(stripEmphasis("Never touch old_payment_ or new_payment_")).toBe(
      "Never touch old_payment_ or new_payment_",
    );
  });
});

// The 2026-10-27 audit's B1: each of these blocked in 1.9.0 and passed in
// 1.10.1, the sixth block-to-pass in this function. Curly quotes are what a
// word processor or chat client writes; emphasis around the whole rule is how
// an AGENTS.md often writes it; a backslash before an underscore is a
// markdown escape, not a Windows path.
const B1_CASES: Array<[string, string]> = [
  ["**Never touch the Dockerfile.**", "Dockerfile"],
  ["*Do not edit CHANGELOG.md.*", "CHANGELOG.md"],
  [`Do not edit ${cp(0x201c)}Makefile${cp(0x201d)}.`, "Makefile"],
  [`Do not edit ${cp(0x201c)}CODEOWNERS${cp(0x201d)}.`, ".github/CODEOWNERS"],
  [`Do not edit ${cp(0x2018)}Makefile${cp(0x2019)}.`, "Makefile"],
  ["Do not modify payment\\_methods.", "db/payment_methods.sql"],
  ["Do not edit <code>Makefile</code>.", "Makefile"],
  ["Do not modify __payment_methods__.", "db/payment_methods.sql"],
  ["Do not modify __payment_method_ids__.", "db/payment_method_ids.sql"],
  [`Do not edit ${cp(0x00ab)}Makefile${cp(0x00bb)}.`, "Makefile"],
  [`Do not edit ${cp(0x300c)}Makefile${cp(0x300d)}.`, "Makefile"],
  [`Do not edit Makefile${cp(0x3002)}`, "Makefile"],
  [`Do not edit Makefile${cp(0x2026)}`, "Makefile"],
  [`Never touch Dockerfile${cp(0xff01)}`, "Dockerfile"],
  [`Never touch Dockerfile${cp(0x061f)}`, "Dockerfile"],
  [`Never touch Dockerfile${cp(0x0964)}`, "Dockerfile"],
  [`Do not edit ${cp(0x201e)}Makefile${cp(0x201c)}.`, "Makefile"],
  ["Never touch `Dockerfile`*", "Dockerfile"],
  ["Never touch $Dockerfile", "Dockerfile"],
  ["Never touch @Dockerfile", "Dockerfile"],
  ["Never touch #Dockerfile", "Dockerfile"],
  [`Never touch Dockerfile${cp(0x200b)}.`, "Dockerfile"],
  ["Never edit \\_\\_init\\_\\_.py", "pkg/__init__.py"],
  ["Never commit id\\_rsa", "keys/id_rsa"],
  [`Never commit ${cp(0x2018)}secrets.json${cp(0x2019)}`, "config/secrets.json"],
];

describe("the closed file-name rule reads typographic, escaped and sentence-wide wrapping (B1)", () => {
  it.each(B1_CASES)("namesChangedFile reads %s as naming %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it.each(B1_CASES)("blocks in drift: %s against %s", (rule, path) => {
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });

  it("still reads a real Windows path, whose backslash is not an escape", () => {
    expect(namesChangedFile("Never touch .\\Dockerfile", ["Dockerfile"])).toBe(true);
    // A directory whose name starts with an underscore reads both ways: the
    // Windows path keeps its last segment, which is not a basename word.
    expect(namesChangedFile("Never touch src\\_private\\Dockerfile.", ["Dockerfile"])).toBe(false);
  });

  it("removes emphasis that spans words without reading a dunder's underscores as its close", () => {
    expect(namesChangedFile("_Never edit __init__.py_", ["pkg/__init__.py"])).toBe(true);
    expect(namesChangedFile("_Never edit payment_methods._", ["db/payment_methods.sql"])).toBe(true);
  });

  it("removes a lone HTML tag as well as a paired one, and keeps <Name> itself", () => {
    expect(namesChangedFile("Do not edit Makefile<br>", ["Makefile"])).toBe(true);
    expect(namesChangedFile("Do not edit <b>the</b> Makefile<br/>", ["Makefile"])).toBe(true);
    expect(namesChangedFile("Do not edit <code><Makefile></code>", ["Makefile"])).toBe(true);
  });

  // The edge trim takes Unicode classes, minus what is part of a name: the
  // dot that starts a dotfile, an identifier's underscore, and the "~" of a
  // home directory.
  it("never trims the characters that are part of a name", () => {
    expect(namesChangedFile("Never commit .env", ["scripts/env.sh"])).toBe(false);
    expect(namesChangedFile("Never touch old_payment_", ["db/old_payment.sql"])).toBe(false);
    expect(namesChangedFile("Never touch old_payment_", ["db/old_payment_.sql"])).toBe(true);
    expect(namesChangedFile("Never touch _old_payment", ["db/old_payment.sql"])).toBe(false);
    expect(namesChangedFile("Never touch ~/Dockerfile", ["Dockerfile"])).toBe(false);
  });

  // `__x__` is bold in markdown and a dunder in Python, and nothing in the
  // text says which. Both readings are candidates, so neither can turn a
  // 1.9.0 block into a pass: __Dockerfile__ is bold, __init__.py a dunder.
  it("keeps the dunder form and the emphasis-stripped form as candidates", () => {
    expect(namesChangedFile("Never touch __payment_methods__", ["db/__payment_methods__"])).toBe(true);
    expect(namesChangedFile("Never touch __payment_methods__", ["db/payment_methods.sql"])).toBe(true);
    expect(namesChangedFile("Never touch __Dockerfile__", ["Dockerfile"])).toBe(true);
    expect(namesChangedFile("Never edit __init__.py", ["pkg/__init__.py"])).toBe(true);
    expect(namesChangedFile("Never edit __init__.py", ["pkg/init.py"])).toBe(true);
  });
});

// A safety net under the closed rule: when a whole basename appears in the
// rule, ignoring case, format characters and markdown escapes, as a word of
// its own, the name-only demotion does not fire. It cannot create a block
// 1.9.0 did not have: the demotion only ever runs on a match the tokens
// already made.
describe("the basename safety net", () => {
  it.each([
    ["Never touch the dockerfile", "Dockerfile"],
    ["Do not edit codeowners.", ".github/CODEOWNERS"],
    [`Do not edit Make${cp(0x00ad)}file.`, "Makefile"],
    ["Never commit ID\\_RSA", "keys/id_rsa"],
  ])("blocks where the closed rule does not read the name: %s against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(false);
    expect(mentionsChangedBasename(rule, [path])).toBe(true);
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });

  it.each([
    // Ruled case-sensitive: a stem is never matched loosely.
    ["Do not touch billing", "src/Billing.tsx"],
    [`Do not touch ${cp(0x201c)}billing${cp(0x201d)}`, "src/Billing.tsx"],
    // A word inside a longer name or a path is not the basename.
    ["Never touch SyncStatus", "src/SyncStatus.tsx"],
    ["Never touch ~/Dockerfile", "Dockerfile"],
    ["Never touch infra/Dockerfile", "Dockerfile"],
    ["Never touch Dockerfile_old", "Dockerfile"],
    ["Never touch docker-Dockerfile", "Dockerfile"],
    ["Never touch prod.Dockerfile", "Dockerfile"],
    ["Never edit __init__.py", "pkg/init.py"],
  ])("does not fire: %s against %s", (rule, path) => {
    expect(mentionsChangedBasename(rule, [path])).toBe(false);
  });

  it("leaves the ruled case-sensitive stem cases a pass in drift", () => {
    const result = scoreDrift(contractWith(["Do not touch billing"]), { changedPaths: ["src/Billing.tsx"] });
    expect(result.categories.scope_creep).toBe(0);
    expect(result.action).toBe("proceed");
  });
});

// The c5532a3 review's M1: the Unicode edge trim took the leading star of a
// glob, so every form became ".pem" and "*.pem" was never reached. Each
// blocked in 1.9.0 and 1.10.1 (the curly-quoted one in 1.9.0 only).
const GLOB_CASES: Array<[string, string]> = [
  ["Never commit '*.pem'.", "certs/server.pem"],
  ["Never commit (*.pem).", "certs/server.pem"],
  ['Never commit "*.pem" files.', "certs/server.pem"],
  ["Never commit *.pem.", "certs/server.pem"],
  ["Never commit *.pem,", "certs/server.pem"],
  ["Never commit *.pem!", "certs/server.pem"],
  ["Never commit *.pem;", "certs/server.pem"],
  ["Never commit *.pem:", "certs/server.pem"],
  ["Never commit `*.pem`.", "certs/server.pem"],
  ["Never commit `*.key`.", "certs/server.key"],
  ["Never commit (`*.key`)", "certs/server.key"],
  ["Never edit *.sql;", "db/schema.sql"],
  ["Never edit *.sql.", "db/schema.sql"],
  ["Never commit *.env.", "config/prod.env"],
  [`Never commit ${cp(0x201c)}*.pem${cp(0x201d)}.`, "certs/server.pem"],
];

describe("a *.ext glob beside punctuation, quotes, backticks or parens", () => {
  it.each(GLOB_CASES)("namesChangedFile reads %s as naming %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
  });

  it.each(GLOB_CASES)("blocks in drift: %s against %s", (rule, path) => {
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
    expect(result.action).not.toBe("proceed");
  });
});

// Intraword emphasis: CommonMark renders **Docker**file as a bold "Docker"
// inside the word Dockerfile. 1.9.0 blocked these through their tokens.
describe("emphasis inside a word", () => {
  it.each([
    ["Never touch **Docker**file", "Dockerfile"],
    ["Never touch Docker*file*.", "Dockerfile"],
    ["Never touch Make**file**", "Makefile"],
  ])("names the file: %s against %s", (rule, path) => {
    expect(namesChangedFile(rule, [path])).toBe(true);
    const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
    expect(result.categories.scope_creep).toBeGreaterThan(0);
  });

  it("never reads an identifier's underscore as intraword emphasis", () => {
    expect(namesChangedFile("Never touch payment_methods", ["db/paymentmethods.sql"])).toBe(false);
  });
});

// The c5532a3 review's N-a: the multi-word emphasis pattern was cubic in the
// rule's length (a 13 KB rule took 138 s). Each reading must stay fast on a
// long adversarial rule.
describe("reading a long adversarial rule stays fast", () => {
  it.each([
    ["repeated underscore pairs", "_a b ".repeat(2700)],
    ["repeated star pairs", "*a b ".repeat(2700)],
    ["unclosed underscores", "_a ".repeat(4500)],
    ["nested emphasis", `${"*_".repeat(1500)}Dockerfile x${"_*".repeat(1500)}`],
    ["deeply nested emphasis", `${"*_ ".repeat(20000)}Dockerfile${" _*".repeat(20000)}`],
    ["unclosed HTML elements", "<b>a ".repeat(2700)],
    ["nested HTML elements", `${"<b>".repeat(1500)}Dockerfile${"</b>".repeat(1500)}`],
    ["deeply nested HTML elements", `${"<b> ".repeat(20000)}Dockerfile${" </b>".repeat(20000)}`],
    ["one long word of emphasis markers", `${"*a_".repeat(3000)} x`],
    ["one long word of nested stars", `${"*".repeat(4000)}a${"*".repeat(4000)}`],
    ["one long word of nested links", `${"[a](".repeat(2000)}b${")".repeat(2000)}`],
  ])("%s", (_name, rule) => {
    const started = Date.now();
    namesChangedFile(rule, ["Dockerfile"]);
    mentionsChangedBasename(rule, ["Dockerfile"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// Property-style: a protected name, wrapped in any combination of the
// wrappers people actually write, still names the file. A new wrapper is
// added here, not as a new special case in wordForms.
const PROTECTED: Array<[string, string]> = [
  ["*.pem", "certs/server.pem"],
  ["*.key", "certs/server.key"],
  ["*.sql", "db/schema.sql"],
  ["*.env", "config/prod.env"],
  ["Dockerfile", "Dockerfile"],
  ["Makefile", "Makefile"],
  ["CODEOWNERS", ".github/CODEOWNERS"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["CHANGELOG", "CHANGELOG.md"],
  ["id_rsa", "keys/id_rsa"],
  ["secrets.json", "config/secrets.json"],
  ["payment_methods", "db/payment_methods.sql"],
  [".env", ".env.local"],
  ["__init__.py", "pkg/__init__.py"],
];

const escapeMarkdown = (name: string): string => name.replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);

const WRAPS: Array<[string, (w: string) => string]> = [
  ["none", (w) => w],
  ["backtick", (w) => `\`${w}\``],
  ["straight double", (w) => `"${w}"`],
  ["straight single", (w) => `'${w}'`],
  ["curly double", (w) => `${cp(0x201c)}${w}${cp(0x201d)}`],
  ["curly single", (w) => `${cp(0x2018)}${w}${cp(0x2019)}`],
  ["low-9", (w) => `${cp(0x201e)}${w}${cp(0x201c)}`],
  ["guillemets", (w) => `${cp(0x00ab)}${w}${cp(0x00bb)}`],
  ["single guillemets", (w) => `${cp(0x2039)}${w}${cp(0x203a)}`],
  ["CJK corner", (w) => `${cp(0x300c)}${w}${cp(0x300d)}`],
  ["CJK white corner", (w) => `${cp(0x300e)}${w}${cp(0x300f)}`],
  ["parens", (w) => `(${w})`],
  ["brackets", (w) => `[${w}]`],
  ["braces", (w) => `{${w}}`],
  ["angle", (w) => `<${w}>`],
  ["code tag", (w) => `<code>${w}</code>`],
  ["bold", (w) => `**${w}**`],
  ["italic star", (w) => `*${w}*`],
  ["italic underscore", (w) => `_${w}_`],
  ["bold underscore", (w) => `__${w}__`],
  ["bold italic", (w) => `***${w}***`],
  ["dollar", (w) => `$${w}`],
  ["at", (w) => `@${w}`],
  ["hash", (w) => `#${w}`],
  ["zero-width space", (w) => `${cp(0x200b)}${w}${cp(0x200b)}`],
];

const SUFFIXES = [
  "", ".", ",", ":", ";", "!", "?",
  // Ideographic full stop, ellipsis, fullwidth ! and ?, Arabic question
  // mark, danda, zero-width space, em dash, no-break space.
  cp(0x3002), cp(0x2026), cp(0xff01), cp(0xff1f), cp(0x061f), cp(0x0964),
  `${cp(0x200b)}.`, cp(0x2014), ").", `${cp(0x00a0)}.`,
];

// An underscore wrapper around a name that itself starts with underscores is
// not a form anybody writes, and markdown cannot express it either.
const applies = (wrapName: string, name: string): boolean =>
  !(name.startsWith("_") && wrapName.includes("underscore"));

describe("a protected name in any combination of wrappers still names the file (property)", () => {
  it("names the file through every pair of wrappers, escaped or not, with a suffix", () => {
    const failures: string[] = [];
    for (const [name, path] of PROTECTED) {
      for (const escaped of [false, true]) {
        const written = escaped ? escapeMarkdown(name) : name;
        WRAPS.forEach(([innerName, inner], i) => {
          WRAPS.forEach(([outerName, outer], j) => {
            if (!applies(innerName, name) || !applies(outerName, name)) return;
            const suffix = SUFFIXES[(i + j) % SUFFIXES.length];
            const rule = `Never touch ${outer(inner(written))}${suffix}`;
            if (!namesChangedFile(rule, [path])) failures.push(`${rule} / ${path}`);
          });
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("names the file inside emphasis that spans the whole rule", () => {
    const failures: string[] = [];
    // [sentence, whether its own underscore sits right against the word]
    const sentences: Array<[(w: string) => string, boolean]> = [
      [(w) => `**Never touch the ${w}.**`, false],
      [(w) => `*Do not edit ${w}.*`, false],
      [(w) => `_Never edit ${w}._`, false],
      [(w) => `***Never touch ${w}***`, false],
      [(w) => `**_Do not edit ${w}_**`, true],
    ];
    for (const [name, path] of PROTECTED) {
      for (const [sentence, underscoreAgainstWord] of sentences) {
        for (const [wrapName, wrap] of WRAPS) {
          if (!applies(wrapName, name)) continue;
          // "_x__" from an underscore wrapper closing against the sentence's
          // own underscore is not markdown emphasis in any renderer.
          if (underscoreAgainstWord && wrapName.includes("underscore")) continue;
          for (const written of [name, escapeMarkdown(name)]) {
            const rule = sentence(wrap(written));
            if (!namesChangedFile(rule, [path])) failures.push(`${rule} / ${path}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("blocks in drift through every single wrapper and suffix", () => {
    const failures: string[] = [];
    for (const [name, path] of PROTECTED) {
      for (const [wrapName, wrap] of WRAPS) {
        if (!applies(wrapName, name)) continue;
        for (const suffix of SUFFIXES) {
          const rule = `Do not touch ${wrap(name)}${suffix}`;
          const result = scoreDrift(contractWith([rule]), { changedPaths: [path] });
          if (result.categories.scope_creep === 0 || result.action === "proceed") {
            failures.push(`${rule} / ${path}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
