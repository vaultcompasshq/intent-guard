import { DRIFT_THRESHOLDS, type DriftAction } from "./rubric.js";

export interface DriftThresholds {
  info: number;
  warn: number;
  soft_block: number;
  hard_block: number;
}

export interface ConductorConfig {
  version: string;
  drift: {
    mode: "handoff" | "file_write" | "every_turn";
    thresholds: DriftThresholds;
    hard_block_on_critical_constraints: boolean;
  };
  coach: {
    show_when_score_below: number;
    patterns_enabled: "all" | string[];
  };
  constraints: {
    priority_order: string[];
  };
  files: {
    active_contract: string;
    contracts_dir: string;
    drift_log: string;
  };
  integrations: {
    superpowers: {
      require_contract_before: string[];
    };
    downstream_pipeline: {
      enabled: boolean;
      issue_tracker_team_id: string | null;
    };
  };
}

export const DEFAULT_CONDUCTOR_CONFIG: ConductorConfig = {
  version: "1.0.0",
  drift: {
    mode: "handoff",
    thresholds: { ...DRIFT_THRESHOLDS },
    hard_block_on_critical_constraints: true,
  },
  coach: {
    show_when_score_below: 60,
    patterns_enabled: "all",
  },
  constraints: {
    priority_order: [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "cursor-rules",
      "project-spec",
    ],
  },
  files: {
    active_contract: "intent-contract.yaml",
    contracts_dir: "contracts",
    drift_log: "drift-log.jsonl",
  },
  integrations: {
    superpowers: {
      require_contract_before: ["brainstorming", "test-driven-development"],
    },
    downstream_pipeline: {
      enabled: false,
      issue_tracker_team_id: null,
    },
  },
};

export function driftActionForScore(
  overall: number,
  thresholds: DriftThresholds,
): DriftAction {
  if (overall >= thresholds.hard_block) return "hard_block";
  if (overall >= thresholds.soft_block) return "soft_block";
  if (overall >= thresholds.warn) return "warn";
  if (overall >= thresholds.info) return "info";
  return "proceed";
}

/*
 * mergeConductorConfig used to live here as a field-by-field merge that
 * accepted anything and dropped anything it did not recognise. It moved to
 * config-schema.ts in 1.4.0 and validates now. Keeping an unvalidated merge
 * exported beside the validating one would leave the second door into the
 * config open, which is the whole thing the schema closes.
 */
