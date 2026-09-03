import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ChangeBudget, IntentContract } from "@vaultcompass/intent-guard-schema";
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";
import { draftContract } from "./extract.js";

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

function readOptional(role: SpecBridgeFile["role"], path?: string): SpecBridgeFile | null {
  if (!path || !existsSync(path)) return null;
  return {
    role,
    path,
    content: readFileSync(path, "utf8"),
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
      options.requirementsPath
        ? resolvePath(projectRoot, options.requirementsPath)
        : join(specDir, SPEC_KIT_FILES.requirements),
    ),
    readOptional(
      "design",
      options.designPath
        ? resolvePath(projectRoot, options.designPath)
        : join(specDir, SPEC_KIT_FILES.design),
    ),
    readOptional(
      "tasks",
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
    readOptional("requirements", requirementsPath),
    readOptional(
      "design",
      options.designPath
        ? resolvePath(projectRoot, options.designPath)
        : join(specDir, KIRO_FILES.design),
    ),
    readOptional(
      "tasks",
      options.tasksPath
        ? resolvePath(projectRoot, options.tasksPath)
        : join(specDir, KIRO_FILES.tasks),
    ),
  ].filter((file): file is SpecBridgeFile => file != null);
}

function readRequired(
  role: SpecBridgeFile["role"],
  label: string,
  path: string,
): SpecBridgeFile {
  const file = readOptional(role, path);
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
    readRequired("requirements", "Superpowers spec", specPath),
    options.designPath
      ? readRequired(
          "design",
          "Design file",
          resolvePath(projectRoot, options.designPath),
        )
      : null,
    options.planPath != null
      ? readRequired("tasks", "Superpowers plan", planPath as string)
      : readOptional("tasks", planPath),
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
 * Validates the budget in place, against the same schema the gate reads, by
 * validating the contract it was just attached to. Only errors inside
 * `/budget` are reported, so an unrelated draft problem is not blamed on the
 * spec file. An invalid budget is an error naming the file, never a silent
 * skip: a budget that quietly vanished would leave the gate wide open.
 */
function assertBudgetValid(contract: IntentContract, path: string): void {
  const result = validateIntentContract(contract);
  if (result.valid) return;
  const budgetErrors = result.errors.filter((error) => error.startsWith("/budget"));
  if (budgetErrors.length === 0) return;
  throw new Error(`Invalid budget block in ${path}:\n${budgetErrors.join("\n")}`);
}

/**
 * Prose only. Fenced blocks are dropped rather than stripped, using the same
 * fence toggle `extractConstraintsFromMarkdown` uses: a superpowers plan is
 * mostly code by design, and feeding source lines into the extractor turned
 * literal `test(...)` lines into acceptance criteria. `extractBudget` reads the
 * raw file content, so dropping fences here does not hide a budget block.
 */
function stripMarkdown(content: string): string {
  const lines: string[] = [];
  let inFence = false;

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+\[[ xX]\]\s+/, "- ")
      .replace(/^[-*]\s+/, "- ")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
    if (line.length > 0) lines.push(line);
  }

  return lines.join("\n");
}

function buildImportText(
  format: Exclude<SpecBridgeFormat, "auto">,
  label: string,
  files: SpecBridgeFile[],
): string {
  const parts = [
    `Import ${format} spec "${label}" into an Intent Guard Intent Contract.`,
  ];

  for (const file of files) {
    const label =
      file.role === "requirements"
        ? "Requirements"
        : file.role === "design"
          ? "Design"
          : "Tasks";
    parts.push(`${label}:\n${stripMarkdown(file.content)}`);
  }

  parts.push(
    "Human review is required before freeze. Do not treat the imported contract as approved.",
  );
  return parts.join("\n\n");
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

  const userText = buildImportText(discovered.format, label, files);
  const contract = draftContract({ userText });

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
  };
}
