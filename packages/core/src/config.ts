import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  DEFAULT_CONDUCTOR_CONFIG,
  type ConductorConfig,
} from "./config-types.js";
import { ConfigError, validateConductorConfig } from "./config-schema.js";
import { stateDir } from "./state-dir.js";

export const CONFIG_FILE = "config.yaml";

export { ConfigError };

export function configPath(projectRoot: string): string {
  return join(stateDir(projectRoot), CONFIG_FILE);
}

/**
 * Parse and validate config text that has already been fetched.
 *
 * Split out from loadConfig so a pull-request run can validate the config it
 * read from the base ref through the same schema and the same messages,
 * naming `ref:path` as the origin instead of a file on disk.
 */
export function parseConfigText(text: string, origin: string): ConductorConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(
      `Invalid ${origin}: ${(error as Error).message.split("\n")[0].trim()}`,
    );
  }
  return validateConductorConfig(raw, origin);
}

/**
 * The project's config, validated.
 *
 * Validation happens HERE and not in a validate subcommand, because a check
 * somebody has to remember to run is not a check. Every command that loads
 * config now refuses a config file that would put a drift band out of the
 * scorer's reach.
 *
 * The path must also be a regular file. The schema floors already bound what
 * a linked config could do, so this is the smaller of the two risks, but
 * having the contract read refuse a link while the config read followed one
 * would be a rule with a hole in it that nobody could remember the shape of.
 * One rule: a control input is a file at the path it is named at.
 */
export function loadConfig(projectRoot: string): ConductorConfig {
  const path = configPath(projectRoot);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { ...DEFAULT_CONDUCTOR_CONFIG };
  }
  if (!stat.isFile()) {
    throw new ConfigError(
      `Invalid ${path}: it is ${stat.isSymbolicLink() ? "a symlink" : "not a regular file"}. ` +
        "Intent Guard reads its config from a file at that path, not through a " +
        "link to somewhere else. Replace it with a regular file.",
    );
  }
  return parseConfigText(readFileSync(path, "utf8"), path);
}

export function defaultConfigYaml(): string {
  return stringify(DEFAULT_CONDUCTOR_CONFIG).trim();
}
