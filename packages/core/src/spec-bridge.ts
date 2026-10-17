import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ChangeBudget, IntentContract } from "@vaultcompass/intent-guard-schema";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import {
  LABELLED_SCOPE_HEADINGS,
  draftContractDetailed,
  isLabelledScopeHeading,
} from "./extract.js";
import type { RuleReplacement } from "./constraints.js";
import { suggestPathBudgets } from "./path-suggestions.js";
import { describeBudgetPathIssues, validateBudgetPaths } from "./budget-paths.js";

export type SpecBridgeFormat = "auto" | "spec-kit" | "kiro" | "superpowers";

export interface SpecBridgeFile {
  role: "requirements" | "design" | "tasks";
  path: string;
  content: string;
}

export interface ImportSpecOptions {
  format?: SpecBridgeFormat;
  specDir?: string;
  requirementsPath?: string;
  designPath?: string;
  tasksPath?: string;
  /** superpowers: the design spec markdown file, imported as requirements. */
  specPath?: string;
  /** superpowers: the plan markdown file, imported as tasks. */
  planPath?: string;
}

export interface ImportedSpecContract {
  format: Exclude<SpecBridgeFormat, "auto">;
  specDir: string;
  files: SpecBridgeFile[];
  contract: IntentContract;
  /** out_of_scope items merged into a longer near-duplicate, for --verbose. */
  replaced: RuleReplacement[];
  /** "file: heading" for each labelled section read, in document order. */
  sections: string[];
  /** Set when no labelled section was found and the draft is empty. */
  warnings: string[];
  /** allowed_paths globs the labelled sections name, to suggest; never written. */
  pathSuggestions: string[];
}

const SPEC_KIT_FILES = {
  requirements: "spec.md",
  design: "plan.md",
  tasks: "tasks.md",
} as const;

const KIRO_FILES = {
  requirements: "requirements.md",
  bugfix: "bugfix.md",
  design: "design.md",
  tasks: "tasks.md",
} as const;

const SUPERPOWERS_DIRS = {
  root: join("docs", "superpowers"),
  specs: join("docs", "superpowers", "specs"),
  plans: join("docs", "superpowers", "plans"),
} as const;

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function newestDirectory(paths: string[]): string | undefined {
  const dirs = paths.filter(isDir);
  if (dirs.length === 0) return undefined;
  return dirs
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].path;
}

function discoverSpecKitDir(projectRoot: string): string | undefined {
  const specsRoot = join(projectRoot, "specs");
  const specifySpecsRoot = join(projectRoot, ".specify", "specs");

  if (isDir(specsRoot)) {
    const children = readdirSync(specsRoot).map((name) => join(specsRoot, name));
    const newest = newestDirectory(children);
    if (newest) return newest;
  }

  if (isDir(specifySpecsRoot)) {
    const children = readdirSync(specifySpecsRoot).map((name) =>
      join(specifySpecsRoot, name),
    );
    const newest = newestDirectory(children);
    if (newest) return newest;
  }

  return undefined;
}

function markdownFilesIn(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

/**
 * The most recently modified spec markdown file, by mtime, with the filename
 * as the tie-break. The tie-break is not cosmetic: a fresh CI checkout writes
 * every file at once, so every spec carries the same mtime and the winner
 * would otherwise be whatever readdir returned first. Names are dated, so
 * descending filename order puts the newest spec first.
 */
function discoverSuperpowersSpec(projectRoot: string): string | undefined {
  const specs = markdownFilesIn(join(projectRoot, SUPERPOWERS_DIRS.specs));
  if (specs.length === 0) return undefined;
  return specs
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))[0].path;
}

/**
 * The plan whose filename stem matches the spec's. Repos that name a spec
 * `<slug>-design.md` pair it with a plan named plain `<slug>.md`, and repos
 * that drop the suffix pair identical stems, so the suffix is optional.
 */
function discoverSuperpowersPlan(
  projectRoot: string,
  specPath: string,
): string | undefined {
  const stem = basename(specPath).replace(/\.md$/i, "").replace(/-design$/i, "");
  const plan = join(projectRoot, SUPERPOWERS_DIRS.plans, `${stem}.md`);
  return existsSync(plan) ? plan : undefined;
}

function hasSuperpowersLayout(projectRoot: string): boolean {
  return markdownFilesIn(join(projectRoot, SUPERPOWERS_DIRS.specs)).length > 0;
}

function discoverKiroDir(projectRoot: string): string | undefined {
  const specsRoot = join(projectRoot, ".kiro", "specs");
  if (!isDir(specsRoot)) return undefined;
  const children = readdirSync(specsRoot).map((name) => join(specsRoot, name));
  return newestDirectory(children);
}

function resolvePath(projectRoot: string, path: string): string {
  return path.startsWith("/") ? path : join(projectRoot, path);
}

// A spec or plan is prose a human wrote, not a data file: a few hundred
// kilobytes is already a large one. The cap exists so a symlink or an
// explicit path aimed at something enormous cannot pull an unbounded read
// into the contract and stdout, and it fails closed with a clear error rather
// than reading a truncated prefix.
const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/**
 * The real path a spec or plan resolves to must sit inside the project. Both
 * the candidate and projectRoot are canonicalised with realpathSync, so a
 * symlink anywhere along either side resolves to its target before the
 * containment test. import-spec auto-discovers the newest markdown under a
 * repository directory and also accepts explicit --spec/--plan paths, so
 * without this a pull request that dropped a symlink under
 * docs/superpowers/specs pointing at any local file would have a maintainer
 * read that file into the contract's original_ask and print it to stdout.
 *
 * Contained-only is the default and the only mode today. A deliberate escape
 * flag could widen it later; there is no supported way to point outside the
 * tree on purpose right now, so none is preserved.
 */
function assertContained(projectRoot: string, path: string): string {
  const realRoot = realpathSync(projectRoot);
  const realPath = realpathSync(path);
  const rel = relative(realRoot, realPath);
  // An empty rel is the root itself; a rel that is ".." or begins a ".."
  // segment, or is absolute, has climbed out of the tree.
  const escapes =
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `Refusing to read a spec outside the project: ${path} resolves to ${realPath}, which is not contained under ${realRoot}.`,
    );
  }
  return realPath;
}

function readOptional(
  role: SpecBridgeFile["role"],
  projectRoot: string,
  path?: string,
): SpecBridgeFile | null {
  if (!path || !existsSync(path)) return null;
  const realPath = assertContained(projectRoot, path);
  const size = statSync(realPath).size;
  if (size > MAX_SPEC_BYTES) {
    throw new Error(
      `Spec file too large to import: ${path} is ${size} bytes, over the ${MAX_SPEC_BYTES}-byte limit.`,
    );
  }
  return {
    role,
    path,
    content: readFileSync(realPath, "utf8"),
  };
}

function discoverFormat(projectRoot: string, options: ImportSpecOptions): {
  format: Exclude<SpecBridgeFormat, "auto">;
  specDir: string;
} {
  // --spec/--plan only mean anything for superpowers, so they select the
  // format when one was not named, and never override an explicit --from.
  const namedSuperpowersFiles =
    options.specPath != null || options.planPath != null;
  const superpowersRequested =
    options.format === "superpowers" ||
    (namedSuperpowersFiles &&
      options.format !== "spec-kit" &&
      options.format !== "kiro");

  if (superpowersRequested) {
    return {
      format: "superpowers",
      specDir: join(projectRoot, SUPERPOWERS_DIRS.root),
    };
  }

  if (options.specDir) {
    const specDir = resolvePath(projectRoot, options.specDir);
    const format =
      options.format && options.format !== "auto"
        ? options.format
        : existsSync(join(specDir, SPEC_KIT_FILES.requirements))
          ? "spec-kit"
          : "kiro";
    return { format, specDir };
  }

  if (options.format === "spec-kit") {
    const specDir = discoverSpecKitDir(projectRoot);
    if (!specDir) throw new Error("No Spec Kit spec directory found");
    return { format: "spec-kit", specDir };
  }

  if (options.format === "kiro") {
    const specDir = discoverKiroDir(projectRoot);
    if (!specDir) throw new Error("No Kiro spec directory found");
    return { format: "kiro", specDir };
  }

  const specKitDir = discoverSpecKitDir(projectRoot);
  if (specKitDir) return { format: "spec-kit", specDir: specKitDir };

  const kiroDir = discoverKiroDir(projectRoot);
  if (kiroDir) return { format: "kiro", specDir: kiroDir };

  // Last, deliberately: a repo that already had a Spec Kit or Kiro layout when
  // superpowers support shipped must keep resolving to the format it did before.
  if (hasSuperpowersLayout(projectRoot)) {
    return {
      format: "superpowers",
      specDir: join(projectRoot, SUPERPOWERS_DIRS.root),
    };
  }

  throw new Error("No supported spec artifacts found");
}

function readSpecKitFiles(
  projectRoot: string,
  specDir: string,
  options: ImportSpecOptions,
): SpecBridgeFile[] {
  return [
    readOptional(
      "requirements",
      projectRoot,
      options.requirementsPath
        ? resolvePath(projectRoot, options.requirementsPath)
        : join(specDir, SPEC_KIT_FILES.requirements),
    ),
    readOptional(
      "design",
      projectRoot,
      options.designPath
        ? resolvePath(projectRoot, options.designPath)
        : join(specDir, SPEC_KIT_FILES.design),
    ),
    readOptional(
      "tasks",
      projectRoot,
      options.tasksPath
        ? resolvePath(projectRoot, options.tasksPath)
        : join(specDir, SPEC_KIT_FILES.tasks),
    ),
  ].filter((file): file is SpecBridgeFile => file != null);
}

function readKiroFiles(
  projectRoot: string,
  specDir: string,
  options: ImportSpecOptions,
): SpecBridgeFile[] {
  const requirementsPath =
    options.requirementsPath != null
      ? resolvePath(projectRoot, options.requirementsPath)
      : firstExisting([
          join(specDir, KIRO_FILES.requirements),
          join(specDir, KIRO_FILES.bugfix),
        ]);

  return [
    readOptional("requirements", projectRoot, requirementsPath),
    readOptional(
      "design",
      projectRoot,
      options.designPath
        ? resolvePath(projectRoot, options.designPath)
        : join(specDir, KIRO_FILES.design),
    ),
    readOptional(
      "tasks",
      projectRoot,
      options.tasksPath
        ? resolvePath(projectRoot, options.tasksPath)
        : join(specDir, KIRO_FILES.tasks),
    ),
  ].filter((file): file is SpecBridgeFile => file != null);
}

function readRequired(
  role: SpecBridgeFile["role"],
  label: string,
  projectRoot: string,
  path: string,
): SpecBridgeFile {
  const file = readOptional(role, projectRoot, path);
  if (!file) throw new Error(`${label} not found: ${path}`);
  return file;
}

/**
 * superpowers keeps one markdown spec and one markdown plan, each a single
 * file rather than a directory of roles: the spec is the requirements, the
 * plan is the tasks. `design` stays empty unless the caller passes one, since
 * the design reasoning lives inside the spec itself.
 */
function readSuperpowersFiles(
  projectRoot: string,
  options: ImportSpecOptions,
): SpecBridgeFile[] {
  if (options.planPath != null && options.specPath == null) {
    throw new Error(
      "A superpowers plan needs its spec: pass --spec as well as --plan. A plan on its own is a task list, not a contract.",
    );
  }

  const specPath =
    options.specPath != null
      ? resolvePath(projectRoot, options.specPath)
      : discoverSuperpowersSpec(projectRoot);

  if (!specPath) {
    throw new Error(
      `No superpowers spec found in ${join(projectRoot, SUPERPOWERS_DIRS.specs)}`,
    );
  }

  const planPath =
    options.planPath != null
      ? resolvePath(projectRoot, options.planPath)
      : options.specPath != null
        ? undefined
        : discoverSuperpowersPlan(projectRoot, specPath);

  return [
    readRequired("requirements", "Superpowers spec", projectRoot, specPath),
    options.designPath
      ? readRequired(
          "design",
          "Design file",
          projectRoot,
          resolvePath(projectRoot, options.designPath),
        )
      : null,
    options.planPath != null
      ? readRequired("tasks", "Superpowers plan", projectRoot, planPath as string)
      : readOptional("tasks", projectRoot, planPath),
  ].filter((file): file is SpecBridgeFile => file != null);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A fenced yaml block whose whole content is a single `budget` key is taken as
 * a change budget for the imported draft. Anything else in a yaml fence (a
 * config sample, a workflow snippet) is left alone, so a spec can show yaml
 * without accidentally declaring a budget.
 *
 * A fence that does not parse is only ignorable when it was not trying to be a
 * budget. One that opens with a `budget:` key and then fails to parse is an
 * error naming the file: skipping it would drop the budget silently and leave
 * the gate open, which is the exact outcome this feature exists to prevent.
 */
function extractBudget(files: SpecBridgeFile[]): {
  budget: ChangeBudget;
  path: string;
} | null {
  // The backreference is the point: CommonMark allows either delimiter, and
  // stripMarkdown already honours both, so reading only backticks left a tilde
  // budget dropped from the prose and never extracted. \1 closes a fence with
  // its own delimiter instead of letting one style close the other.
  const fence = /(```|~~~)ya?ml[^\n]*\n([\s\S]*?)\1/gi;
  // The key may be quoted. YAML gives `"budget":` the same plain key, so a
  // quoted key that parsed was already honoured while a quoted key that failed
  // to parse was skipped. That asymmetry is the bug: this sentinel is what
  // decides whether a broken fence fails loudly or vanishes.
  const looksLikeBudget = /^\s*["']?budget["']?\s*:/m;
  for (const file of files) {
    for (const match of file.content.matchAll(fence)) {
      const body = match[2];
      let parsed: unknown;
      try {
        parsed = parseYaml(body);
      } catch (error) {
        if (!looksLikeBudget.test(body)) continue;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid budget block in ${file.path}:\n${detail}`);
      }
      if (!isPlainObject(parsed)) continue;
      const keys = Object.keys(parsed);
      if (keys.length !== 1 || keys[0] !== "budget") continue;
      return { budget: parsed.budget as ChangeBudget, path: file.path };
    }
  }
  return null;
}

/**
 * Validates the budget in place: first against the shared glob rules in
 * budget-paths.ts, which name the offending value and why in one readable
 * line, then against the same schema the gate reads, by validating the
 * contract it was just attached to (only errors inside `/budget` are
 * reported, so an unrelated draft problem is not blamed on the spec file).
 * The glob check runs first because it is a superset of what the schema's
 * own pattern catches (leading slash, backslash, surrounding whitespace):
 * without this order, an entry that fails both would be reported through
 * AJV's terser "must match pattern" message instead of the one naming the
 * value. Either failure is an error naming the file, never a silent skip: a
 * budget that quietly vanished, or that carries a `protected_paths` entry
 * matching nothing, would leave the gate wide open.
 */
function assertBudgetValid(contract: IntentContract, path: string): void {
  const issues = validateBudgetPaths(contract.budget);
  if (issues.length > 0) {
    throw new Error(`Invalid budget block in ${path}:\n${describeBudgetPathIssues(issues)}`);
  }
  const result = validateIntentContract(contract);
  if (!result.valid) {
    const budgetErrors = result.errors.filter((error) => error.startsWith("/budget"));
    if (budgetErrors.length > 0) {
      throw new Error(`Invalid budget block in ${path}:\n${budgetErrors.join("\n")}`);
    }
  }
}

/**
 * Prose only. Fenced blocks are dropped rather than stripped, using the same
 * fence toggle `extractConstraintsFromMarkdown` uses: a superpowers plan is
 * mostly code by design, and feeding source lines into the extractor turned
 * literal `test(...)` lines into acceptance criteria. `extractBudget` reads the
 * raw file content, so dropping fences here does not hide a budget block.
 *
 * Heading markers are KEPT. Extraction routes by section (a "Non-goals"
 * heading sends its bullets to out_of_scope, a "Background" heading keeps its
 * problem statements out of the prohibitions), and through 1.8.1 this function
 * dropped the `#` so every heading read as an ordinary line. extract.ts strips
 * the marker itself once it has read the level.
 */
function cleanSpecLine(trimmed: string): string {
  return trimmed
    .replace(/^[-*]\s+\[[ xX]\]\s+/, "- ")
    .replace(/^[-*]\s+/, "- ")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

const SPEC_ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SPEC_BOLD_HEADING_RE = /^(\*\*|__)(.+?)\1\s*:?\s*$/;
const SPEC_BOLD_LABEL_RE = /^(\*\*|__)(.+?)\1\s*:?\s+(.+)$/;
const SPEC_COLON_LABEL_RE = /^([A-Za-z][^:]{2,60}):$/;
const SPEC_BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;
// A Gherkin block opener, as a line or a heading: everything under it is a
// test scenario, not scope.
const GHERKIN_BLOCK_RE = /^(?:Feature|Scenario(?:\s+Outline)?|Background|Examples|Rule)\s*:/;
// A step written with a bold keyword ("**Given** x, **When** y"), in any case.
const BOLD_STEP_RE = /^(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)(?:given|when|then|and|but)(?:\*\*|__)/i;
// A plain step keyword, title case only: an EARS "WHEN x THE SYSTEM SHALL y"
// requirement is upper case and stays. "Given" opens a run of steps; When,
// Then, And and But are steps only inside one.
const GIVEN_STEP_RE = /^(?:(?:[-*+]|\d+[.)])\s+)?Given\s/;
const NEXT_STEP_RE = /^(?:(?:[-*+]|\d+[.)])\s+)?(?:When|Then|And|But|\*)\s/;

export interface LabelledSpecText {
  /** The labelled sections' lines, cleaned, with their headings. */
  text: string;
  /** The heading of each labelled section found, in document order. */
  headings: string[];
}

/**
 * Only the labelled scope sections of a spec (see LABELLED_SCOPE_HEADINGS),
 * prose only. Through 1.9.0 the whole file was read, so a competitor survey
 * or a Gherkin scenario became scope or a prohibition. A labelled `#` heading
 * covers everything to the next heading of the same or a higher level,
 * nested headings included, so a Non-goals heading under Scope still routes.
 * A labelled bold or "Label:" pseudo-heading covers the list under it. Inside
 * a section, Gherkin scenarios and steps and table rows are dropped.
 *
 * Fenced blocks are dropped, using the same fence toggle
 * `extractConstraintsFromMarkdown` uses: a superpowers plan is mostly code,
 * and source lines turned into acceptance criteria. `extractBudget` reads the
 * raw file content, so dropping fences here does not hide a budget block.
 * Heading markers are kept, because extraction routes by section.
 */
export function selectLabelledSections(content: string): LabelledSpecText {
  const lines: string[] = [];
  const headings: string[] = [];
  let inFence = false;
  // The open labelled section: its heading level (7 for a pseudo-heading).
  let section: number | null = null;
  // A Gherkin scenario heading's level, while its body is being skipped.
  let scenario: number | null = null;
  let inGherkinBlock = false;
  let inSteps = false;

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) {
      inGherkinBlock = false;
      inSteps = false;
      continue;
    }

    const atx = trimmed.match(SPEC_ATX_RE);
    if (atx) {
      const level = atx[1].length;
      const title = atx[2];
      inGherkinBlock = false;
      inSteps = false;
      if (scenario !== null && level <= scenario) scenario = null;
      if (section !== null && level <= section) section = null;
      if (section === null && isLabelledScopeHeading(title)) {
        section = level;
        headings.push(title.replace(/[*_`]/g, "").trim());
        lines.push(cleanSpecLine(trimmed));
        continue;
      }
      if (section === null || scenario !== null) continue;
      if (GHERKIN_BLOCK_RE.test(title)) {
        scenario = level;
        continue;
      }
      lines.push(cleanSpecLine(trimmed));
      continue;
    }
    if (scenario !== null) continue;

    // A pseudo-heading section holds its list only: the first line that is
    // neither a bullet nor an indented continuation closes it.
    if (section === 7 && !SPEC_BULLET_RE.test(trimmed) && raw === raw.trimStart()) {
      section = null;
    }
    const pseudo = trimmed.match(SPEC_BOLD_HEADING_RE)?.[2] ?? trimmed.match(SPEC_COLON_LABEL_RE)?.[1];
    if (section === null && pseudo && isLabelledScopeHeading(pseudo)) {
      section = 7;
      headings.push(pseudo.replace(/[*_`]/g, "").trim());
      lines.push(cleanSpecLine(trimmed));
      continue;
    }
    const label = trimmed.match(SPEC_BOLD_LABEL_RE);
    if (section === null && label && isLabelledScopeHeading(label[2])) {
      headings.push(label[2].replace(/[*_`:]/g, "").trim());
      lines.push(cleanSpecLine(trimmed));
      continue;
    }
    if (section === null) continue;

    if (trimmed.startsWith("|")) continue;
    if (GHERKIN_BLOCK_RE.test(trimmed)) {
      inGherkinBlock = true;
      continue;
    }
    if (inGherkinBlock) continue;
    if (BOLD_STEP_RE.test(trimmed) || GIVEN_STEP_RE.test(trimmed)) {
      inSteps = true;
      continue;
    }
    if (inSteps && NEXT_STEP_RE.test(trimmed)) continue;
    inSteps = false;

    lines.push(cleanSpecLine(trimmed));
  }

  return { text: lines.join("\n"), headings };
}

/** The single in_scope item of a draft imported from a spec with no labelled section. */
export const NO_LABELLED_SCOPE_ITEM =
  "No labelled scope section was found; replace this with the agreed scope";

function noLabelledSectionWarning(files: SpecBridgeFile[]): string {
  return (
    `No labelled scope section found in ${files.map((file) => basename(file.path)).join(", ")}. ` +
    `import-spec reads only sections headed ${LABELLED_SCOPE_HEADINGS.join(", ")} ` +
    "(and their common spellings), and never builds a contract from the whole file. " +
    "The draft is empty: add one of those headings to the spec, or write the contract by hand."
  );
}

function importHeader(format: Exclude<SpecBridgeFormat, "auto">, label: string): string {
  return `Import ${format} spec "${label}" into an Intent Guard Intent Contract.`;
}

function buildImportText(
  format: Exclude<SpecBridgeFormat, "auto">,
  label: string,
  files: SpecBridgeFile[],
): { text: string; sections: string[]; selected: string } {
  const parts = [importHeader(format, label)];
  const sections: string[] = [];
  const selectedTexts: string[] = [];

  for (const file of files) {
    const selected = selectLabelledSections(file.content);
    if (selected.headings.length === 0) continue;
    sections.push(...selected.headings.map((heading) => `${basename(file.path)}: ${heading}`));
    const label =
      file.role === "requirements"
        ? "Requirements"
        : file.role === "design"
          ? "Design"
          : "Tasks";
    // A level-1 heading, not a plain line: it closes whatever section the
    // previous file ended in, so a Non-goals list at the end of one file
    // cannot swallow the next file. Added after section selection, so this
    // "Requirements:" heading never labels a file by itself.
    parts.push(`# ${label}:\n${selected.text}`);
    selectedTexts.push(selected.text);
  }

  // No closing "Human review is required ... Do not treat the imported
  // contract as approved." sentence any more: extraction read it as a rule,
  // and on a spec with no prohibitions of its own it was the contract's only
  // out_of_scope item. import-spec says it to the reader instead.
  return { text: parts.join("\n\n"), sections, selected: selectedTexts.join("\n") };
}

export function importSpecContract(
  projectRoot: string,
  options: ImportSpecOptions = {},
): ImportedSpecContract {
  const discovered = discoverFormat(projectRoot, options);
  const files =
    discovered.format === "superpowers"
      ? readSuperpowersFiles(projectRoot, options)
      : discovered.format === "spec-kit"
        ? readSpecKitFiles(projectRoot, discovered.specDir, options)
        : readKiroFiles(projectRoot, discovered.specDir, options);

  if (files.length === 0) {
    throw new Error(`No readable spec files found in ${discovered.specDir}`);
  }

  // superpowers has no per-feature directory to name the import after, so the
  // spec file's own stem is the label.
  const label =
    discovered.format === "superpowers"
      ? basename(files[0].path).replace(/\.md$/i, "")
      : basename(discovered.specDir);

  const built = buildImportText(discovered.format, label, files);
  const ask = importHeader(discovered.format, label);
  const warnings: string[] = [];
  const { contract, replaced } = draftContractDetailed({ userText: built.text, ask });
  if (built.sections.length === 0) {
    // Nothing labelled: an empty draft and a warning, never a contract built
    // from the whole file. The one in_scope item is a placeholder because the
    // schema requires one.
    warnings.push(noLabelledSectionWarning(files));
    contract.in_scope = [NO_LABELLED_SCOPE_ITEM];
    contract.out_of_scope = [];
    contract.acceptance_criteria = [
      { id: "ac-1", description: "Replace with the acceptance criteria agreed for this change", testable: true },
    ];
  }

  // Scoped to superpowers on purpose: a yaml fence in a Spec Kit or Kiro file
  // never carried this meaning before, and reading one now would change what
  // an existing repo's import produces.
  const found = discovered.format === "superpowers" ? extractBudget(files) : null;
  if (found) {
    contract.budget = found.budget;
    assertBudgetValid(contract, found.path);
  }

  return {
    ...discovered,
    files,
    contract,
    replaced: built.sections.length === 0 ? [] : replaced,
    sections: built.sections,
    warnings,
    // Suggestions only: never written into the draft's budget.
    pathSuggestions: suggestPathBudgets(built.selected, projectRoot),
  };
}
