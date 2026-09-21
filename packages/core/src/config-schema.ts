/**
 * A schema and floors for `.intent-guard/config.yaml`.
 *
 * The config file used to be merged field by field with no validation at all:
 * anything the YAML parser accepted became config, and every unrecognised key
 * was silently dropped. Two consequences, and the second is the one that
 * matters. A typo in a key name did nothing and said nothing. And a drift
 * threshold could be set to any number, so `hard_block: 101` disabled blocking
 * outright, because the drift score is capped at 100 and every band is tested
 * with `>=`. A file that turns the gate off has to be refused rather than
 * merged, and it has to be refused on every load rather than in a validate
 * subcommand somebody has to remember to run.
 *
 * The floors here are deliberately narrow. They bound what a value may be, not
 * what a project may decide: a team that only wants to block on maximum drift
 * can still set every band to 100, and a team that trusts its own critical
 * constraints can still turn `hard_block_on_critical_constraints` off. What is
 * refused is a value outside the range the scorer can ever produce, which is
 * never a policy anybody chose on purpose.
 */

import { DRIFT_THRESHOLDS } from "./rubric.js";
import {
  DEFAULT_CONDUCTOR_CONFIG,
  type ConductorConfig,
  type DriftThresholds,
} from "./config-types.js";

/**
 * A config file this tool refuses to act on, described for a user rather than
 * as a stack trace. Every CLI entry point catches this class and prints one
 * line, the way it already does for a refused state directory.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The highest value the drift scorer can ever produce. */
export const MAX_DRIFT_SCORE = 100;

const DRIFT_MODES = ["handoff", "file_write", "every_turn"] as const;

interface Ctx {
  /** What to name in a message: a file path, or `ref:path` for a base read. */
  origin: string;
}

function fail(ctx: Ctx, detail: string): never {
  throw new ConfigError(`Invalid ${ctx.origin}: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a block";
  // JSON.stringify renders NaN and Infinity as the literal "null", so
  // `warn: .nan` used to be reported as "got null", sending a reader off to
  // look for an empty value that is not in their file. YAML's own tokens for
  // these are what they typed, so those are what the message says.
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return ".nan";
    return value > 0 ? ".inf" : "-.inf";
  }
  return JSON.stringify(value);
}

/**
 * Rejects any key the schema does not name. A dropped key is a setting the
 * user believes is in force and is not, which is the failure mode this whole
 * file exists to end, so an unknown key is an error rather than a warning.
 */
function object(ctx: Ctx, value: unknown, path: string, allowed: string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    fail(ctx, `${path === "" ? "the file" : path} must be a block, got ${describe(value)}.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(ctx, `unknown key "${path === "" ? key : `${path}.${key}`}".`);
    }
  }
  return value;
}

function optionalString(ctx: Ctx, value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    fail(ctx, `${path} must be text, got ${describe(value)}.`);
  }
  return value;
}

function optionalBoolean(ctx: Ctx, value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    fail(ctx, `${path} must be true or false, got ${describe(value)}.`);
  }
  return value;
}

function optionalStringList(ctx: Ctx, value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(ctx, `${path} must be a list of text values, got ${describe(value)}.`);
  }
  return value as string[];
}

/**
 * A drift band. The ceiling is the whole point: the scorer caps the overall
 * score at 100 and compares with `>=`, so any band above 100 is a band that
 * can never be entered, and setting one is indistinguishable from turning the
 * gate off.
 */
function optionalScore(ctx: Ctx, value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(ctx, `${path} must be a number from 0 to ${MAX_DRIFT_SCORE}, got ${describe(value)}.`);
  }
  if (value < 0 || value > MAX_DRIFT_SCORE) {
    fail(ctx, `${path} must be a number from 0 to ${MAX_DRIFT_SCORE}, got ${value}.`);
  }
  return value;
}

function optionalCoverage(ctx: Ctx, value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(ctx, `${path} must be a number from 0 to 1, got ${describe(value)}.`);
  }
  if (value < 0 || value > 1) {
    fail(ctx, `${path} must be a number from 0 to 1, got ${value}.`);
  }
  return value;
}

function thresholds(ctx: Ctx, raw: unknown): DriftThresholds {
  const block = object(ctx, raw, "drift.thresholds", [
    "info",
    "warn",
    "soft_block",
    "hard_block",
    "strong_coverage",
    "partial_coverage",
  ]);
  const parsed: DriftThresholds = {
    info: optionalScore(ctx, block.info, "drift.thresholds.info") ?? DRIFT_THRESHOLDS.info,
    warn: optionalScore(ctx, block.warn, "drift.thresholds.warn") ?? DRIFT_THRESHOLDS.warn,
    soft_block:
      optionalScore(ctx, block.soft_block, "drift.thresholds.soft_block") ??
      DRIFT_THRESHOLDS.soft_block,
    hard_block:
      optionalScore(ctx, block.hard_block, "drift.thresholds.hard_block") ??
      DRIFT_THRESHOLDS.hard_block,
    strong_coverage: optionalCoverage(ctx, block.strong_coverage, "drift.thresholds.strong_coverage"),
    partial_coverage: optionalCoverage(
      ctx,
      block.partial_coverage,
      "drift.thresholds.partial_coverage",
    ),
  };
  const strongCoverage = parsed.strong_coverage ?? 0.5;
  const partialCoverage = parsed.partial_coverage ?? 0.3;
  if (partialCoverage > strongCoverage) {
    fail(
      ctx,
      `drift.thresholds.partial_coverage (${partialCoverage}) must not be greater than drift.thresholds.strong_coverage (${strongCoverage}).`,
    );
  }
  return parsed;
}

/**
 * Validate raw parsed YAML and merge it over the defaults.
 *
 * This replaces the old merge-only path entirely, so validation cannot be
 * skipped by calling the merge directly.
 */
export function validateConductorConfig(raw: unknown, origin: string): ConductorConfig {
  const ctx: Ctx = { origin };
  const root = object(ctx, raw, "", [
    "version",
    "drift",
    "coach",
    "constraints",
    "files",
    "integrations",
  ]);

  const driftBlock = object(ctx, root.drift, "drift", [
    "mode",
    "thresholds",
    "hard_block_on_critical_constraints",
  ]);
  const mode = optionalString(ctx, driftBlock.mode, "drift.mode");
  if (mode !== undefined && !DRIFT_MODES.includes(mode as (typeof DRIFT_MODES)[number])) {
    fail(ctx, `drift.mode must be one of ${DRIFT_MODES.join(", ")}, got ${JSON.stringify(mode)}.`);
  }

  const coachBlock = object(ctx, root.coach, "coach", [
    "show_when_score_below",
    "patterns_enabled",
  ]);
  let patternsEnabled: ConductorConfig["coach"]["patterns_enabled"] | undefined;
  if (coachBlock.patterns_enabled !== undefined && coachBlock.patterns_enabled !== null) {
    if (coachBlock.patterns_enabled === "all") {
      patternsEnabled = "all";
    } else {
      patternsEnabled = optionalStringList(
        ctx,
        coachBlock.patterns_enabled,
        "coach.patterns_enabled",
      );
    }
  }

  const constraintsBlock = object(ctx, root.constraints, "constraints", ["priority_order"]);
  const filesBlock = object(ctx, root.files, "files", [
    "active_contract",
    "contracts_dir",
    "drift_log",
  ]);
  const integrationsBlock = object(ctx, root.integrations, "integrations", [
    "superpowers",
    "downstream_pipeline",
  ]);
  const superpowersBlock = object(
    ctx,
    integrationsBlock.superpowers,
    "integrations.superpowers",
    ["require_contract_before"],
  );
  const pipelineBlock = object(
    ctx,
    integrationsBlock.downstream_pipeline,
    "integrations.downstream_pipeline",
    ["enabled", "issue_tracker_team_id"],
  );

  const defaults = DEFAULT_CONDUCTOR_CONFIG;
  return {
    version: optionalString(ctx, root.version, "version") ?? defaults.version,
    drift: {
      mode: (mode as ConductorConfig["drift"]["mode"] | undefined) ?? defaults.drift.mode,
      thresholds: thresholds(ctx, driftBlock.thresholds),
      hard_block_on_critical_constraints:
        optionalBoolean(
          ctx,
          driftBlock.hard_block_on_critical_constraints,
          "drift.hard_block_on_critical_constraints",
        ) ?? defaults.drift.hard_block_on_critical_constraints,
    },
    coach: {
      show_when_score_below:
        optionalScore(ctx, coachBlock.show_when_score_below, "coach.show_when_score_below") ??
        defaults.coach.show_when_score_below,
      patterns_enabled: patternsEnabled ?? defaults.coach.patterns_enabled,
    },
    constraints: {
      priority_order:
        optionalStringList(ctx, constraintsBlock.priority_order, "constraints.priority_order") ??
        defaults.constraints.priority_order,
    },
    files: {
      active_contract:
        optionalString(ctx, filesBlock.active_contract, "files.active_contract") ??
        defaults.files.active_contract,
      contracts_dir:
        optionalString(ctx, filesBlock.contracts_dir, "files.contracts_dir") ??
        defaults.files.contracts_dir,
      drift_log:
        optionalString(ctx, filesBlock.drift_log, "files.drift_log") ??
        defaults.files.drift_log,
    },
    integrations: {
      superpowers: {
        require_contract_before:
          optionalStringList(
            ctx,
            superpowersBlock.require_contract_before,
            "integrations.superpowers.require_contract_before",
          ) ?? defaults.integrations.superpowers.require_contract_before,
      },
      downstream_pipeline: {
        enabled:
          optionalBoolean(
            ctx,
            pipelineBlock.enabled,
            "integrations.downstream_pipeline.enabled",
          ) ?? defaults.integrations.downstream_pipeline.enabled,
        issue_tracker_team_id:
          optionalString(
            ctx,
            pipelineBlock.issue_tracker_team_id,
            "integrations.downstream_pipeline.issue_tracker_team_id",
          ) ?? defaults.integrations.downstream_pipeline.issue_tracker_team_id,
      },
    },
  };
}

/**
 * Merge a partially specified config over the defaults, validating it.
 *
 * Kept for the name it has always had in the public API. Before 1.4.0 it was a
 * merge with no validation, so this now throws where it used to silently
 * accept; that is the point, and it is why 1.4.0 is a minor rather than a
 * patch. There is exactly one merge path, and it is this one.
 */
export function mergeConductorConfig(raw: Partial<ConductorConfig>): ConductorConfig {
  return validateConductorConfig(raw, "config");
}
