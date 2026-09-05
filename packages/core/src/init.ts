import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigYaml, CONFIG_FILE } from "./config.js";
import { renderIndex } from "./memory-index.js";
import { LEGACY_STATE_DIR, STATE_DIR, ensureStateDir } from "./state-dir.js";

export const INIT_NEXT_STEPS = [
  "intent-guard extract --project . --text \"<your ask>\"",
  "intent-guard freeze --project . --approved-by <you>",
  "intent-guard doctor --project .",
  "intent-guard check --project . --staged",
  "Optional: intent-guard hook install --project . (add --with-vault-guard to pair secret scanning)",
] as const;

/**
 * Printed after init so the answer to "do I commit this?" arrives with the
 * directory rather than a search later. Contracts are reviewable artifacts and
 * belong in the repository; the drift log is local noise.
 */
export const INIT_GITIGNORE_HINT =
  `Commit ${STATE_DIR}/ so contracts are reviewable, and add ` +
  `${STATE_DIR}/drift-log.jsonl to .gitignore. Before 1.3.0 this directory was ` +
  `named ${LEGACY_STATE_DIR}/; if your .gitignore still names it, update the ` +
  `entry, and if this run migrated an existing directory, stage the rename ` +
  `with: git add -A ${STATE_DIR} ${LEGACY_STATE_DIR}`;

export interface InitResult {
  state_dir: string;
  /**
   * @deprecated since 1.3.0. Use `state_dir`. Frozen at its 1.2 meaning, the
   * `<projectRoot>/.conductor` path, so a consumer reading this field keeps
   * getting what it got before. Removed in 2.0.
   */
  conductor_dir: string;
  created: string[];
  skipped: string[];
  next_steps: string[];
  gitignore_hint: string;
}

export function initConductor(projectRoot: string): InitResult {
  const dir = ensureStateDir(projectRoot);
  const created: string[] = [];
  const skipped: string[] = [];

  const configFile = join(dir, CONFIG_FILE);
  if (!existsSync(configFile)) {
    writeFileSync(configFile, `${defaultConfigYaml()}\n`, "utf8");
    created.push(`${STATE_DIR}/${CONFIG_FILE}`);
  } else {
    skipped.push(`${STATE_DIR}/${CONFIG_FILE}`);
  }

  const indexPath = join(dir, "index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, renderIndex(projectRoot), "utf8");
    created.push(`${STATE_DIR}/index.md`);
  } else {
    skipped.push(`${STATE_DIR}/index.md`);
  }

  const contractsDir = join(dir, "contracts");
  if (!existsSync(contractsDir)) {
    mkdirSync(contractsDir, { recursive: true });
    created.push(`${STATE_DIR}/contracts/`);
  } else {
    skipped.push(`${STATE_DIR}/contracts/`);
  }

  return {
    state_dir: dir,
    conductor_dir: join(projectRoot, LEGACY_STATE_DIR),
    created,
    skipped,
    next_steps: [...INIT_NEXT_STEPS],
    gitignore_hint: INIT_GITIGNORE_HINT,
  };
}
