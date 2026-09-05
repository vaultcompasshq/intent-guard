import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LEGACY_STATE_DIR,
  STATE_DIR,
  ensureStateDir,
  inspectStateDir,
  resetStateDirNotices,
  stateDir,
} from "../src/state-dir.js";
import { initConductor } from "../src/init.js";
import { configPath, loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";

function scratchRepo(): string {
  return mkdtempSync(join(tmpdir(), "intent-guard-state-"));
}

function seedLegacy(root: string): string {
  const legacy = join(root, LEGACY_STATE_DIR);
  mkdirSync(join(legacy, "contracts"), { recursive: true });
  writeFileSync(join(legacy, "config.yaml"), "drift:\n  thresholds:\n    soft_block: 80\n", "utf8");
  return legacy;
}

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStateDirNotices();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

function stderrText(): string {
  return stderr.mock.calls.map((call) => String(call[0])).join("");
}

describe("state directory resolution", () => {
  it("writes a fresh project to the canonical directory and never the legacy one", () => {
    const root = scratchRepo();
    const result = initConductor(root);

    expect(result.created).toContain(`${STATE_DIR}/config.yaml`);
    expect(existsSync(join(root, STATE_DIR, "config.yaml"))).toBe(true);
    expect(existsSync(join(root, LEGACY_STATE_DIR))).toBe(false);
    expect(result.state_dir).toBe(join(root, STATE_DIR));
  });

  it("reads a legacy-only project from the legacy directory and says so once", () => {
    const root = scratchRepo();
    seedLegacy(root);

    expect(stateDir(root)).toBe(join(root, LEGACY_STATE_DIR));
    expect(loadConfig(root).drift.thresholds.soft_block).toBe(80);
    expect(configPath(root)).toBe(join(root, LEGACY_STATE_DIR, "config.yaml"));

    const notice = stderrText();
    expect(notice).toContain(LEGACY_STATE_DIR);
    expect(notice).toContain(STATE_DIR);
    // One line for the whole invocation, however many reads it took.
    expect(notice.split("\n").filter((line) => line.includes(STATE_DIR)).length).toBe(1);
  });

  it("migrates a legacy-only project by renaming it on the first write", () => {
    const root = scratchRepo();
    seedLegacy(root);
    writeFileSync(join(root, LEGACY_STATE_DIR, "keepsake.txt"), "keep me\n", "utf8");

    const dir = ensureStateDir(root);

    expect(dir).toBe(join(root, STATE_DIR));
    expect(existsSync(join(root, LEGACY_STATE_DIR))).toBe(false);
    // The rename carries every file across, not just the ones we know about.
    expect(readFileSync(join(root, STATE_DIR, "keepsake.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(root, STATE_DIR, "contracts"))).toBe(true);
    expect(loadConfig(root).drift.thresholds.soft_block).toBe(80);
    expect(stderrText()).toContain(`renamed ${LEGACY_STATE_DIR}/ to ${STATE_DIR}/`);
  });

  it("fails closed when both directories exist, naming both", () => {
    const root = scratchRepo();
    seedLegacy(root);
    mkdirSync(join(root, STATE_DIR), { recursive: true });

    expect(() => stateDir(root)).toThrow(
      new RegExp(`${STATE_DIR}[\\s\\S]*${LEGACY_STATE_DIR}`),
    );
    expect(() => ensureStateDir(root)).toThrow(
      new RegExp(`${STATE_DIR}[\\s\\S]*${LEGACY_STATE_DIR}`),
    );
    // Failing closed means nothing moved.
    expect(existsSync(join(root, LEGACY_STATE_DIR, "config.yaml"))).toBe(true);
  });

  it("leaves an unrelated legacy-named directory alone", () => {
    const root = scratchRepo();
    mkdirSync(join(root, LEGACY_STATE_DIR), { recursive: true });
    writeFileSync(join(root, LEGACY_STATE_DIR, "notes.md"), "someone else's\n", "utf8");

    const status = inspectStateDir(root);
    expect(status.legacyExists).toBe(false);
    expect(status.usingLegacy).toBe(false);
    expect(stateDir(root)).toBe(join(root, STATE_DIR));
    expect(stderrText()).toBe("");

    initConductor(root);
    expect(existsSync(join(root, STATE_DIR, "config.yaml"))).toBe(true);
    expect(readFileSync(join(root, LEGACY_STATE_DIR, "notes.md"), "utf8")).toBe(
      "someone else's\n",
    );
  });

  it("reports the directory in use and any leftover legacy directory in doctor", () => {
    const canonical = scratchRepo();
    initConductor(canonical);
    const clean = runDoctor(canonical);
    expect(clean.stateDir).toBe(join(canonical, STATE_DIR));
    const cleanFinding = clean.findings.find((f) => f.id === "conductor_dir_found");
    expect(cleanFinding?.status).toBe("ok");
    expect(cleanFinding?.path).toBe(`${STATE_DIR}/`);
    expect(clean.findings.some((f) => f.id === "state_dir_legacy")).toBe(false);

    const legacy = scratchRepo();
    seedLegacy(legacy);
    const stale = runDoctor(legacy);
    expect(stale.stateDir).toBe(join(legacy, LEGACY_STATE_DIR));
    const staleFinding = stale.findings.find((f) => f.id === "state_dir_legacy");
    expect(staleFinding?.status).toBe("warn");
    expect(staleFinding?.message).toContain(STATE_DIR);
    expect(staleFinding?.path).toBe(`${LEGACY_STATE_DIR}/`);
  });
});
