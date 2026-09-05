import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DriftAction } from "./rubric.js";
import { ensureStateDir, stateDir } from "./state-dir.js";

export interface DriftLogEvent {
  timestamp: string;
  contract_id: string;
  overall: number;
  action: DriftAction;
  findings: string[];
  changed_paths?: string[];
  user_message?: string;
}

export const DRIFT_LOG_FILE = "drift-log.jsonl";

export function driftLogPath(projectRoot: string): string {
  return join(stateDir(projectRoot), DRIFT_LOG_FILE);
}

export function appendDriftEvent(
  projectRoot: string,
  event: Omit<DriftLogEvent, "timestamp">,
): void {
  const dir = ensureStateDir(projectRoot);
  const line = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
  appendFileSync(join(dir, DRIFT_LOG_FILE), `${line}\n`, "utf8");
}
