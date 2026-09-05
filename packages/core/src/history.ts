import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import {
  assertValidIntentContract,
  type IntentContract,
} from "@vaultcompass/intent-guard-schema";
import { ensureStateDir, stateDir } from "./state-dir.js";

const CONTRACTS_DIR = "contracts";

export interface ArchivedContractSummary {
  contract_id: string;
  original_ask: string;
  frozen_at: string;
  archived_path: string;
  updated_at: string;
  approved_by?: string;
}

export function contractsDir(projectRoot: string): string {
  return join(stateDir(projectRoot), CONTRACTS_DIR);
}

export function archivedContractPath(
  projectRoot: string,
  contractId: string,
): string {
  return join(contractsDir(projectRoot), `${contractId}.yaml`);
}

export function archiveContract(
  projectRoot: string,
  contract: IntentContract,
): string {
  assertValidIntentContract(contract);
  // Archiving is a write, so it migrates a legacy directory before resolving.
  const dir = join(ensureStateDir(projectRoot), CONTRACTS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${contract.contract_id}.yaml`);
  writeFileSync(path, stringify(contract), "utf8");
  return path;
}

export function readArchivedContract(
  projectRoot: string,
  contractId: string,
): IntentContract | null {
  const path = archivedContractPath(projectRoot, contractId);
  if (!existsSync(path)) return null;
  const raw = parse(readFileSync(path, "utf8"));
  return assertValidIntentContract(raw);
}

export function listContracts(projectRoot: string): ArchivedContractSummary[] {
  const dir = contractsDir(projectRoot);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = join(dir, file);
      const raw = parse(readFileSync(path, "utf8"));
      const contract = assertValidIntentContract(raw);
      const stat = statSync(path);
      return {
        contract_id: contract.contract_id,
        original_ask: contract.original_ask,
        frozen_at: contract.frozen_at,
        // Relative to the project root, so it names whichever state directory
        // is actually in use rather than a hard-coded one.
        archived_path: relative(projectRoot, path),
        updated_at: stat.mtime.toISOString(),
        approved_by: contract.approval?.approved_by,
      };
    })
    .sort((a, b) => {
      const frozenDelta =
        Date.parse(b.frozen_at) - Date.parse(a.frozen_at);
      if (frozenDelta !== 0) return frozenDelta;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });
}
