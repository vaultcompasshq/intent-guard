#!/usr/bin/env node
/**
 * Change Budget dogfood against real public repo layouts.
 *
 * Clones a couple of small public repos, freezes a contract, injects a real
 * `budget`, stages real changes, and asserts the gate behaves as designed.
 * This is where path/glob/manifest edge cases show up that unit tests miss.
 *
 * Network required (clones from GitHub); manual, not run in CI. Exits 0 when
 * every probe passes, 1 on a failed probe, and 2 when the clone step cannot
 * reach GitHub (treated as skipped, not failed).
 *
 * Usage (from repo root, after build):
 *   node scripts/dogfood-budget.mjs
 *   pnpm dogfood:budget
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "packages/cli/dist/intent-guard.js");
const work = join(tmpdir(), "conductor-budget-dogfood");
const REPOS = ["sindresorhus/is", "chalk/chalk"];

function run(cmd, args, cwd = repoRoot) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function node(args, cwd) { return run(process.execPath, args, cwd); }

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

function contractPath(repoPath) {
  return join(repoPath, ".conductor/intent-contract.yaml");
}

// Set a budget on the frozen contract by rewriting a marked YAML block.
function setBudget(repoPath, yamlBlock) {
  const p = contractPath(repoPath);
  let raw = readFileSync(p, "utf8");
  raw = raw.replace(/\n# dogfood-budget[\s\S]*?# end-dogfood-budget\n/g, "\n");
  raw += `\n# dogfood-budget\n${yamlBlock}\n# end-dogfood-budget\n`;
  writeFileSync(p, raw, "utf8");
}

function stageCheck(repoPath, files, contents) {
  for (let i = 0; i < files.length; i++) {
    appendFileSync(join(repoPath, files[i]), contents[i] ?? "\n");
    run("git", ["add", "--", files[i]], repoPath);
  }
  const r = node([cli, "check", "--project", repoPath, "--staged", "--json"], repoPath);
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch { /* noop */ }
  for (const f of files) {
    run("git", ["restore", "--staged", "--", f], repoPath);
    run("git", ["checkout", "--", f], repoPath);
  }
  return { status: r.status, parsed };
}

function setup(repo) {
  const slug = repo.replace(/[^\w.-]+/g, "__");
  const repoPath = join(work, slug);
  rmSync(repoPath, { recursive: true, force: true });
  const clone = run("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, repoPath]);
  if (clone.status !== 0) return null;
  run("git", ["config", "user.name", "Dogfood"], repoPath);
  run("git", ["config", "user.email", "dogfood@example.invalid"], repoPath);
  node([cli, "init", "--project", repoPath], repoPath);
  node([cli, "extract", "--project", repoPath, "--text",
    "Update the readme usage docs. Do not change source or dependencies. Done when one usage example is documented."], repoPath);
  node([cli, "freeze", "--project", repoPath, "--approved-by", "dogfood"], repoPath);
  return repoPath;
}

mkdirSync(work, { recursive: true });

for (const repo of REPOS) {
  console.log(`\n=== ${repo} ===`);
  const repoPath = setup(repo);
  if (!repoPath) {
    console.log(`  skipped (could not clone ${repo}; offline?)`);
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }
  const files = run("git", ["ls-files"], repoPath).out.split("\n").filter(Boolean);
  const hasPkg = files.includes("package.json");
  const srcFile = files.find((f) => /^(src|source|lib)\/.+\.(t|j)s$/.test(f)) || files.find((f) => /\.(t|j)s$/.test(f) && !/test/.test(f));
  const testFile = files.find((f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.(t|j)s$/.test(f));
  const readme = files.find((f) => /^readme(\.|$)/i.test(f)) || "README.md";
  console.log(`  layout: pkg=${hasPkg} src=${srcFile} test=${testFile}`);

  if (testFile) {
    setBudget(repoPath, `budget:\n  protected_paths:\n    - "**/test/**"\n    - "**/*.test.js"\n    - "**/*.test.ts"`);
    const r = stageCheck(repoPath, [testFile], ["\n// probe\n"]);
    check(`protected_paths blocks ${testFile}`, r.status === 1 && r.parsed?.budget?.action === "hard_block",
      `status=${r.status} action=${r.parsed?.budget?.action}`);
  }

  if (srcFile) {
    setBudget(repoPath, `budget:\n  allowed_paths:\n    - "${readme}"`);
    const r = stageCheck(repoPath, [srcFile], ["\n// probe\n"]);
    check(`allowed_paths soft_blocks ${srcFile}`, r.status === 1 && r.parsed?.budget?.violations?.some((v) => v.rule === "allowed_paths"),
      `status=${r.status} action=${r.parsed?.budget?.action}`);
  }

  {
    setBudget(repoPath, `budget:\n  allowed_paths:\n    - "${readme}"`);
    const r = stageCheck(repoPath, [readme], ["\n\nusage probe\n"]);
    check(`allowed_paths passes ${readme}`, !r.parsed?.budget || r.parsed.budget.ok === true,
      `budget=${JSON.stringify(r.parsed?.budget)}`);
  }

  if (srcFile) {
    setBudget(repoPath, `budget:\n  max_files: 1`);
    const r = stageCheck(repoPath, [readme, srcFile], ["\nx\n", "\n// y\n"]);
    check(`max_files soft_blocks 2>1`, r.parsed?.budget?.violations?.some((v) => v.rule === "max_files"),
      `action=${r.parsed?.budget?.action}`);
  }

  if (srcFile) {
    const dir = srcFile.split("/")[0];
    setBudget(repoPath, `budget:\n  protected_paths:\n    - "${dir}"`);
    let r = stageCheck(repoPath, [srcFile], ["\n// probe\n"]);
    check(`protected bare-dir "${dir}" blocks ${srcFile}`, r.status === 1 && r.parsed?.budget?.action === "hard_block",
      `action=${r.parsed?.budget?.action}`);
    setBudget(repoPath, `budget:\n  allowed_paths:\n    - "${dir}"`);
    r = stageCheck(repoPath, [srcFile], ["\n// probe\n"]);
    check(`allowed bare-dir "${dir}" passes ${srcFile}`, !r.parsed?.budget || r.parsed.budget.ok === true,
      `budget=${JSON.stringify(r.parsed?.budget)}`);
  }

  if (hasPkg) {
    setBudget(repoPath, `budget:\n  allow_new_dependencies: false`);
    const r = stageCheck(repoPath, ["package.json"], ["\n"]);
    check(`allow_new_dependencies flags package.json`, r.parsed?.budget?.violations?.some((v) => v.rule === "allow_new_dependencies"),
      `action=${r.parsed?.budget?.action}`);
  }
}

console.log(`\n=== dogfood: ${pass} pass, ${fail} fail ===`);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
