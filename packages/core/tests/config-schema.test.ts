import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigError, loadConfig, parseConfigText } from "../src/config.js";
import { STATE_DIR } from "../src/state-dir.js";

function projectWithConfig(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "intent-guard-config-"));
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(join(root, STATE_DIR, "config.yaml"), body, "utf8");
  return root;
}

const EXAMPLE_CONFIG = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "examples",
  "intent-guard.config.example.yaml",
);

describe("config schema and floors", () => {
  it("rejects a drift threshold above 100", () => {
    const body = "drift:\n  thresholds:\n    hard_block: 101\n";
    expect(() => parseConfigText(body, "config.yaml")).toThrow(ConfigError);
    expect(() => parseConfigText(body, "config.yaml")).toThrow(
      /drift\.thresholds\.hard_block.*0 to 100.*101/s,
    );
  });

  it("accepts a drift threshold of exactly 100", () => {
    const config = parseConfigText(
      "drift:\n  thresholds:\n    hard_block: 100\n",
      "config.yaml",
    );
    expect(config.drift.thresholds.hard_block).toBe(100);
  });

  it("rejects a negative drift threshold", () => {
    expect(() =>
      parseConfigText("drift:\n  thresholds:\n    info: -1\n", "config.yaml"),
    ).toThrow(/drift\.thresholds\.info/);
  });

  it("names .nan and .inf by the token the user typed, not as null", () => {
    // JSON.stringify renders both as the literal "null", which sent a reader
    // looking for an empty value that is nowhere in their file.
    expect(() =>
      parseConfigText("drift:\n  thresholds:\n    warn: .nan\n", "config.yaml"),
    ).toThrow(/got \.nan/);
    expect(() =>
      parseConfigText("drift:\n  thresholds:\n    warn: .inf\n", "config.yaml"),
    ).toThrow(/got \.inf/);
    expect(() =>
      parseConfigText("coach:\n  show_when_score_below: -.inf\n", "config.yaml"),
    ).toThrow(/got -\.inf/);
  });

  it("rejects a non-boolean hard_block_on_critical_constraints", () => {
    const body = "drift:\n  hard_block_on_critical_constraints: \"false\"\n";
    expect(() => parseConfigText(body, "config.yaml")).toThrow(ConfigError);
    expect(() => parseConfigText(body, "config.yaml")).toThrow(
      /hard_block_on_critical_constraints must be true or false/,
    );
  });

  it("rejects an unknown key and names it by its full path", () => {
    expect(() =>
      parseConfigText("drift:\n  thresholds:\n    hardblock: 10\n", "config.yaml"),
    ).toThrow(/unknown key "drift\.thresholds\.hardblock"/);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseConfigText("enforce: false\n", "config.yaml")).toThrow(
      /unknown key "enforce"/,
    );
  });

  it("rejects a drift mode outside the three known modes", () => {
    expect(() => parseConfigText("drift:\n  mode: never\n", "config.yaml")).toThrow(
      /drift\.mode/,
    );
  });

  it("names the origin it was given, so a base-ref read is distinguishable", () => {
    expect(() =>
      parseConfigText(
        "drift:\n  thresholds:\n    warn: 900\n",
        "main:.intent-guard/config.yaml",
      ),
    ).toThrow(/main:\.intent-guard\/config\.yaml/);
  });

  it("validates on every loadConfig, not only in a validate subcommand", () => {
    const root = projectWithConfig("drift:\n  thresholds:\n    soft_block: 101\n");
    expect(() => loadConfig(root)).toThrow(ConfigError);
  });

  it("still returns defaults when no config file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "intent-guard-config-"));
    expect(loadConfig(root).drift.thresholds.hard_block).toBe(86);
  });

  it("accepts the shipped example config unchanged", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");
    const config = parseConfigText(body, "examples/intent-guard.config.example.yaml");
    expect(config.drift.thresholds.soft_block).toBe(71);
    expect(config.integrations.downstream_pipeline.issue_tracker_team_id).toBeNull();
  });

  it("rejects partial_coverage above strong_coverage and names both values", () => {
    const body =
      "drift:\n  thresholds:\n    strong_coverage: 0.3\n    partial_coverage: 0.9\n";
    expect(() => parseConfigText(body, "config.yaml")).toThrow(ConfigError);
    expect(() => parseConfigText(body, "config.yaml")).toThrow(
      /partial_coverage \(0\.9\).*strong_coverage \(0\.3\)/,
    );
  });

  it("accepts equal partial_coverage and strong_coverage", () => {
    const config = parseConfigText(
      "drift:\n  thresholds:\n    strong_coverage: 0.4\n    partial_coverage: 0.4\n",
      "config.yaml",
    );
    expect(config.drift.thresholds.strong_coverage).toBe(0.4);
    expect(config.drift.thresholds.partial_coverage).toBe(0.4);
  });

  it("accepts a partial config and fills the rest from defaults", () => {
    const config = parseConfigText("drift:\n  thresholds:\n    warn: 40\n", "config.yaml");
    expect(config.drift.thresholds.warn).toBe(40);
    expect(config.drift.thresholds.hard_block).toBe(86);
    expect(config.coach.show_when_score_below).toBe(60);
  });
});
