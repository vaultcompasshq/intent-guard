import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { IntentContract } from "@vaultcompass/intent-guard-schema";
import { configPath, loadConfig } from "./config.js";
import {
  contractPath,
  isContractFrozen,
  readContract,
} from "./contract-store.js";
import {
  LEGACY_STATE_DIR,
  STATE_DIR,
  inspectStateDir,
} from "./state-dir.js";
import { archivedContractPath, contractsDir, listContracts } from "./history.js";
import { INDEX_FILE, renderIndex } from "./memory-index.js";
import { resolveGitHooksDir } from "./hook.js";

export type DoctorFindingStatus = "ok" | "info" | "warn" | "error";
export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  status: DoctorFindingStatus;
  message: string;
  path?: string;
  detail?: string;
}

export interface DoctorSummary {
  ok: number;
  info: number;
  warn: number;
  error: number;
}

export interface DoctorResult {
  projectRoot: string;
  /** The state directory actually in use: canonical, or legacy if only it exists. */
  stateDir: string;
  /** @deprecated since 1.3.0. Use `stateDir`. */
  conductorDir: string;
  packageVersion: string;
  status: DoctorStatus;
  exitCode: number;
  summary: DoctorSummary;
  findings: DoctorFinding[];
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function finding(
  status: DoctorFindingStatus,
  id: string,
  message: string,
  path?: string,
  detail?: string,
): DoctorFinding {
  return { id, status, message, path, detail };
}

function summarize(findings: DoctorFinding[]): DoctorSummary {
  return {
    ok: findings.filter((f) => f.status === "ok").length,
    info: findings.filter((f) => f.status === "info").length,
    warn: findings.filter((f) => f.status === "warn").length,
    error: findings.filter((f) => f.status === "error").length,
  };
}

function finalize(
  projectRoot: string,
  findings: DoctorFinding[],
): DoctorResult {
  const summary = summarize(findings);
  const status: DoctorStatus =
    summary.error > 0 ? "error" : summary.warn > 0 ? "warn" : "ok";
  const dir = inspectStateDir(projectRoot).dir;
  return {
    projectRoot,
    stateDir: dir,
    conductorDir: dir,
    packageVersion: packageVersion(),
    status,
    exitCode: summary.error > 0 ? 1 : 0,
    summary,
    findings,
  };
}

function readText(path: string): string | null {
  try {
    if (!existsSync(path) || statSync(path).isDirectory()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Matches the old name as well as the new one. A project wired up before the
 * 1.2.0 rename has hooks, workflows, and rules that say "conductor", and those
 * integrations are still real: reporting them as missing would send people to
 * re-wire something that already works.
 */
function textMentionsIntentGuard(path: string): boolean {
  return /intent[- ]guard|conductor/i.test(readText(path) ?? "");
}

function textMentionsVaultGuard(path: string): boolean {
  return /vault[- ]guard/i.test(readText(path) ?? "");
}

function textMentionsDepGuard(path: string): boolean {
  return /dep[- ]guard/i.test(readText(path) ?? "");
}

function commandVersion(command: string): string | null {
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.signal || result.status !== 0) return null;
    return (result.stdout || result.stderr).trim().split("\n")[0] || "available";
  } catch {
    return null;
  }
}

function filesInDir(path: string, extensions: string[]): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path)
      .filter((file) => extensions.some((ext) => file.endsWith(ext)))
      .map((file) => join(path, file));
  } catch {
    return [];
  }
}

/**
 * Finding paths name the state directory actually in use, so a project still
 * on the legacy name is not told to look somewhere that does not exist.
 */
function stateLabel(projectRoot: string): string {
  return inspectStateDir(projectRoot).usingLegacy ? LEGACY_STATE_DIR : STATE_DIR;
}

function activeContractStatus(
  projectRoot: string,
  findings: DoctorFinding[],
): IntentContract | null {
  const label = stateLabel(projectRoot);
  const activePath = contractPath(projectRoot);
  if (!existsSync(activePath)) {
    findings.push(
      finding(
        "error",
        "active_contract_missing",
        "No active Intent Contract found. Run intent-guard extract, review it, then intent-guard freeze.",
        `${label}/intent-contract.yaml`,
      ),
    );
    return null;
  }

  try {
    const contract = readContract(projectRoot);
    if (!contract) return null;
    findings.push(
      finding(
        "ok",
        "active_contract_valid",
        `Active contract ${contract.contract_id} is schema-valid.`,
        `${label}/intent-contract.yaml`,
      ),
    );

    if (isContractFrozen(contract)) {
      findings.push(
        finding(
          "ok",
          "active_contract_frozen",
          `Active contract is frozen and approved by ${contract.approval?.approved_by}.`,
          `${label}/intent-contract.yaml`,
        ),
      );
    } else {
      findings.push(
        finding(
          "error",
          "active_contract_unfrozen",
          "Active contract exists but is not approved/frozen. Run intent-guard freeze --approved-by <name>.",
          `${label}/intent-contract.yaml`,
        ),
      );
    }
    return contract;
  } catch (error) {
    findings.push(
      finding(
        "error",
        "active_contract_invalid",
        "Active Intent Contract is not valid.",
        `${label}/intent-contract.yaml`,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
}

function configStatus(projectRoot: string, findings: DoctorFinding[]): void {
  const label = stateLabel(projectRoot);
  const path = configPath(projectRoot);
  if (!existsSync(path)) {
    findings.push(
      finding(
        "error",
        "config_missing",
        `Missing ${label}/config.yaml. Run intent-guard init.`,
        `${label}/config.yaml`,
      ),
    );
    return;
  }

  try {
    parse(readFileSync(path, "utf8"));
    loadConfig(projectRoot);
    findings.push(
      finding("ok", "config_valid", "Config file is readable.", `${label}/config.yaml`),
    );
  } catch (error) {
    findings.push(
      finding(
        "error",
        "config_invalid",
        "Config file cannot be parsed or merged.",
        `${label}/config.yaml`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

function archiveStatus(
  projectRoot: string,
  contract: IntentContract | null,
  findings: DoctorFinding[],
): void {
  const label = stateLabel(projectRoot);
  const dir = contractsDir(projectRoot);
  if (!existsSync(dir)) {
    findings.push(
      finding(
        "warn",
        "contracts_dir_missing",
        "Archived contracts directory is missing. Run intent-guard init or freeze the active contract again.",
        `${label}/contracts/`,
      ),
    );
    return;
  }

  try {
    const archived = listContracts(projectRoot);
    findings.push(
      finding(
        archived.length > 0 ? "ok" : "info",
        "contracts_archive_readable",
        archived.length > 0
          ? `${archived.length} archived contract(s) found.`
          : "No archived contracts yet.",
        `${label}/contracts/`,
      ),
    );

    if (
      contract &&
      isContractFrozen(contract) &&
      !existsSync(archivedContractPath(projectRoot, contract.contract_id))
    ) {
      findings.push(
        finding(
          "warn",
          "active_contract_not_archived",
          `Frozen active contract is not archived under ${label}/contracts/.`,
          `${label}/contracts/${contract.contract_id}.yaml`,
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        "warn",
        "contracts_archive_invalid",
        "One or more archived contracts could not be read.",
        `${label}/contracts/`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

function indexStatus(projectRoot: string, findings: DoctorFinding[]): void {
  const label = stateLabel(projectRoot);
  const path = join(inspectStateDir(projectRoot).dir, INDEX_FILE);
  if (!existsSync(path)) {
    findings.push(
      finding(
        "warn",
        "index_missing",
        `Missing ${label}/index.md. Run intent-guard index.`,
        `${label}/index.md`,
      ),
    );
    return;
  }

  try {
    const actual = readFileSync(path, "utf8").trim();
    const expected = renderIndex(projectRoot).trim();
    findings.push(
      finding(
        actual === expected ? "ok" : "warn",
        actual === expected ? "index_current" : "index_stale",
        actual === expected
          ? "Generated index is current."
          : "Generated index is stale. Run intent-guard index.",
        `${label}/index.md`,
      ),
    );
  } catch (error) {
    findings.push(
      finding(
        "warn",
        "index_unreadable",
        "Generated index could not be checked.",
        `${label}/index.md`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

function resolveGitPreCommitHook(
  projectRoot: string,
): { absolutePath: string; displayPath: string } | null {
  const gitDir = join(projectRoot, ".git");
  if (!existsSync(gitDir)) return null;

  const resolved = resolveGitHooksDir(projectRoot);
  const hookPath = join(resolved.hooksDir, "pre-commit");
  if (existsSync(hookPath)) {
    return {
      absolutePath: hookPath,
      displayPath: resolved.displayHookPath,
    };
  }
  return null;
}

function integrationStatus(projectRoot: string, findings: DoctorFinding[]): void {
  const vaultGuardConfig = [
    ".vault-guard.json",
    ".vault-guard.local.json",
    ".vault-guard.yaml",
    ".vault-guard.yml",
  ].find((path) => existsSync(join(projectRoot, path)));
  const vaultGuardVersion = commandVersion("vault-guard");
  const vaultGuardEvidence: string[] = [];

  const depGuardConfig = [
    ".dep-guard.json",
    ".dep-guard.local.json",
    ".dep-guard.yaml",
    ".dep-guard.yml",
  ].find((path) => existsSync(join(projectRoot, path)));
  const depGuardVersion = commandVersion("dep-guard");
  const depGuardEvidence: string[] = [];

  if (vaultGuardConfig) {
    vaultGuardEvidence.push(vaultGuardConfig);
    findings.push(
      finding(
        "ok",
        "vault_guard_config_present",
        "vault-guard config is present.",
        vaultGuardConfig,
      ),
    );
  }

  if (vaultGuardVersion) {
    findings.push(
      finding(
        "ok",
        "vault_guard_binary_found",
        `vault-guard binary found: ${vaultGuardVersion}`,
      ),
    );
  }

  if (depGuardConfig) {
    depGuardEvidence.push(depGuardConfig);
    findings.push(
      finding(
        "ok",
        "dep_guard_config_present",
        "dep-guard config is present.",
        depGuardConfig,
      ),
    );
  }

  if (depGuardVersion) {
    findings.push(
      finding(
        "ok",
        "dep_guard_binary_found",
        `dep-guard binary found: ${depGuardVersion}`,
      ),
    );
  }

  const gitDir = join(projectRoot, ".git");
  if (existsSync(gitDir)) {
    const preCommitHook = resolveGitPreCommitHook(projectRoot);
    if (!preCommitHook) {
      findings.push(
        finding(
          "info",
          "git_pre_commit_missing",
          "No Git pre-commit hook detected.",
          ".git/hooks/pre-commit",
        ),
      );
    } else if (textMentionsIntentGuard(preCommitHook.absolutePath)) {
      findings.push(
        finding(
          "ok",
          "git_pre_commit_conductor",
          "Git pre-commit hook mentions Intent Guard.",
          preCommitHook.displayPath,
        ),
      );
    } else {
      findings.push(
        finding(
          "warn",
          "git_pre_commit_without_conductor",
          "Git pre-commit hook exists but does not mention Intent Guard.",
          preCommitHook.displayPath,
        ),
      );
    }

    if (
      preCommitHook &&
      textMentionsVaultGuard(preCommitHook.absolutePath)
    ) {
      vaultGuardEvidence.push(preCommitHook.displayPath);
      findings.push(
        finding(
          "ok",
          "git_pre_commit_vault_guard",
          "Git pre-commit hook mentions vault-guard.",
          preCommitHook.displayPath,
        ),
      );
    }

    if (preCommitHook && textMentionsDepGuard(preCommitHook.absolutePath)) {
      depGuardEvidence.push(preCommitHook.displayPath);
      findings.push(
        finding(
          "ok",
          "git_pre_commit_dep_guard",
          "Git pre-commit hook mentions dep-guard.",
          preCommitHook.displayPath,
        ),
      );
    }
  }

  const workflowFiles = filesInDir(join(projectRoot, ".github", "workflows"), [
    ".yml",
    ".yaml",
  ]);
  if (workflowFiles.length > 0) {
    const hasConductor = workflowFiles.some(textMentionsIntentGuard);
    findings.push(
      finding(
        hasConductor ? "ok" : "info",
        hasConductor ? "github_actions_conductor" : "github_actions_without_conductor",
        hasConductor
          ? "At least one GitHub Actions workflow mentions Intent Guard."
          : "GitHub Actions workflows exist but none mention Intent Guard.",
        ".github/workflows/",
      ),
    );

    if (workflowFiles.some(textMentionsVaultGuard)) {
      vaultGuardEvidence.push(".github/workflows/");
      findings.push(
        finding(
          "ok",
          "github_actions_vault_guard",
          "At least one GitHub Actions workflow mentions vault-guard.",
          ".github/workflows/",
        ),
      );
    }

    if (workflowFiles.some(textMentionsDepGuard)) {
      depGuardEvidence.push(".github/workflows/");
      findings.push(
        finding(
          "ok",
          "github_actions_dep_guard",
          "At least one GitHub Actions workflow mentions dep-guard.",
          ".github/workflows/",
        ),
      );
    }
  }

  const codexHooks = join(projectRoot, ".codex", "hooks.json");
  if (existsSync(codexHooks)) {
    findings.push(
      finding(
        textMentionsIntentGuard(codexHooks) ? "ok" : "warn",
        textMentionsIntentGuard(codexHooks)
          ? "codex_hooks_conductor"
          : "codex_hooks_without_conductor",
        textMentionsIntentGuard(codexHooks)
          ? "Codex hooks mention Intent Guard."
          : "Codex hooks file exists but does not mention Intent Guard.",
        ".codex/hooks.json",
      ),
    );
  }

  const claudeSettings = join(projectRoot, ".claude", "settings.json");
  if (existsSync(claudeSettings)) {
    findings.push(
      finding(
        textMentionsIntentGuard(claudeSettings) ? "ok" : "warn",
        textMentionsIntentGuard(claudeSettings)
          ? "claude_hooks_conductor"
          : "claude_hooks_without_conductor",
        textMentionsIntentGuard(claudeSettings)
          ? "Claude Code settings mention Intent Guard."
          : "Claude Code settings exist but do not mention Intent Guard.",
        ".claude/settings.json",
      ),
    );
  }

  const cursorRules = filesInDir(join(projectRoot, ".cursor", "rules"), [".mdc"]);
  if (cursorRules.length > 0) {
    const hasConductor = cursorRules.some(textMentionsIntentGuard);
    findings.push(
      finding(
        hasConductor ? "ok" : "info",
        hasConductor ? "cursor_rules_conductor" : "cursor_rules_without_conductor",
        hasConductor
          ? "Cursor rules mention Intent Guard."
          : "Cursor rules exist but none mention Intent Guard.",
        ".cursor/rules/",
      ),
    );
  }

  if (vaultGuardEvidence.length === 0 && !vaultGuardVersion) {
    findings.push(
      finding(
        "info",
        "vault_guard_not_detected",
        "Optional vault-guard secret scanning is not detected.",
      ),
    );
  } else if (vaultGuardEvidence.length > 0 && !vaultGuardVersion) {
    findings.push(
      finding(
        "warn",
        "vault_guard_binary_missing",
        "vault-guard is referenced by project files, but the binary was not found on PATH.",
        vaultGuardEvidence.join(", "),
      ),
    );
  }

  // dep-guard gets the same treatment as vault-guard: both are optional
  // sibling guards, and a project that references one in a hook or workflow
  // without having the binary installed has a gate that cannot run.
  if (depGuardEvidence.length === 0 && !depGuardVersion) {
    findings.push(
      finding(
        "info",
        "dep_guard_not_detected",
        "Optional dep-guard dependency scanning is not detected.",
      ),
    );
  } else if (depGuardEvidence.length > 0 && !depGuardVersion) {
    findings.push(
      finding(
        "warn",
        "dep_guard_binary_missing",
        "dep-guard is referenced by project files, but the binary was not found on PATH.",
        depGuardEvidence.join(", "),
      ),
    );
  }
}

export function runDoctor(projectRoot: string): DoctorResult {
  const findings: DoctorFinding[] = [
    finding(
      "ok",
      "package_version",
      `@vaultcompass/intent-guard-core ${packageVersion()}`,
    ),
  ];

  const state = inspectStateDir(projectRoot);

  if (state.conflict) {
    findings.push(
      finding(
        "error",
        "state_dir_conflict",
        `Both ${STATE_DIR}/ and ${LEGACY_STATE_DIR}/ exist. Intent Guard reads ` +
          `one and never merges two. Move what you need into ${STATE_DIR}/ and ` +
          `delete ${LEGACY_STATE_DIR}/.`,
        `${STATE_DIR}/`,
        `${LEGACY_STATE_DIR}/ is the pre-1.3.0 name for the same directory.`,
      ),
    );
    integrationStatus(projectRoot, findings);
    return finalize(projectRoot, findings);
  }

  if (!state.canonicalExists && !state.usingLegacy) {
    findings.push(
      finding(
        "error",
        "conductor_not_initialized",
        `No ${STATE_DIR} directory found. Run intent-guard init.`,
        `${STATE_DIR}/`,
      ),
    );
    integrationStatus(projectRoot, findings);
    return finalize(projectRoot, findings);
  }

  if (state.usingLegacy) {
    findings.push(
      finding(
        "warn",
        "state_dir_legacy",
        `Project state is still in ${LEGACY_STATE_DIR}/, renamed to ${STATE_DIR}/ ` +
          `in 1.3.0. The next write migrates it, or run: git mv ` +
          `${LEGACY_STATE_DIR} ${STATE_DIR}`,
        `${LEGACY_STATE_DIR}/`,
      ),
    );
  } else {
    findings.push(
      finding(
        "ok",
        "conductor_dir_found",
        `${STATE_DIR} directory exists.`,
        `${STATE_DIR}/`,
      ),
    );
  }

  configStatus(projectRoot, findings);
  const contract = activeContractStatus(projectRoot, findings);
  archiveStatus(projectRoot, contract, findings);
  if (contract) indexStatus(projectRoot, findings);
  integrationStatus(projectRoot, findings);

  return finalize(projectRoot, findings);
}
