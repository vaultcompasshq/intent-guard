import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// The SKILL.md files ship in the published skill package and get copied into
// an agent's skills directory, so every command they document runs in SOME
// OTHER project. They used to say `pnpm --filter
// @vaultcompass/intent-guard-skill exec intent-guard-drift ...`, which only
// works inside this monorepo: anywhere else pnpm prints "No projects matched
// the filters" and exits 0, having run nothing, and an agent following the
// drift-guard skill read that as "drift scored, no findings" (2026-10-12
// audit, F5).

const SKILL_ROOT = join(import.meta.dirname, "..");
const CLI_PACKAGE = join(SKILL_ROOT, "..", "cli");
const DOCUMENTED = "npx --no-install @vaultcompass/intent-guard";

function skillFiles(): { name: string; text: string }[] {
  return readdirSync(SKILL_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILL_ROOT, entry.name, "SKILL.md"))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => ({ name: path.slice(SKILL_ROOT.length + 1), text: readFileSync(path, "utf8") }));
}

/** Lines inside ```bash fences. */
function bashLines(text: string): string[] {
  const lines: string[] = [];
  let inBash = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inBash = !inBash && line.startsWith("```bash");
      continue;
    }
    if (inBash) lines.push(line.trim());
  }
  return lines;
}

/**
 * A machine with no intent-guard anywhere: no npm or pnpm config inherited
 * from the test runner, no network, an empty global prefix, and no PATH entry
 * that already holds an intent-guard binary (a global install, or this
 * repository's own node_modules/.bin). npx runs a matching binary it finds on
 * PATH, so leaving one there would test this machine, not the documented
 * command. node itself comes from a temp directory holding only a link to it.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const nodeOnly = mkdtempSync(join(tmpdir(), "intent-guard-skill-node-"));
  symlinkSync(process.execPath, join(nodeOnly, "node"));
  const globalPrefix = mkdtempSync(join(tmpdir(), "intent-guard-skill-global-"));
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && !existsSync(join(entry, "intent-guard")));
  return {
    PATH: [nodeOnly, ...path].join(delimiter),
    HOME: process.env.HOME,
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_prefix: globalPrefix,
  };
}

function runDocumented(cwd: string, args: string[]) {
  const [, ...rest] = DOCUMENTED.split(" ");
  const npx = join(dirname(process.execPath), "npx");
  return spawnSync(npx, [...rest, ...args], {
    cwd,
    env: isolatedEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("SKILL.md commands work outside this monorepo", () => {
  const files = skillFiles();

  it("finds the four shipped skills", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "capture-correction/SKILL.md",
      "drift-guard/SKILL.md",
      "intent-contract/SKILL.md",
      "prompt-coach/SKILL.md",
    ]);
  });

  for (const file of skillFiles()) {
    it(`${file.name} never documents a monorepo-only command`, () => {
      expect(file.text).not.toContain("pnpm --filter");
      expect(file.text).not.toMatch(/after `?pnpm build`?/i);
    });

    it(`${file.name} runs every intent-guard command through the installed package`, () => {
      const invocations = bashLines(file.text).filter((line) => /intent-guard/.test(line) && !line.startsWith("#") && !line.startsWith("--"));
      expect(invocations.length).toBeGreaterThan(0);
      for (const line of invocations) {
        expect(line.startsWith(`${DOCUMENTED} `)).toBe(true);
      }
    });

    it(`${file.name} tells the agent that a failed or empty run is not a pass`, () => {
      expect(file.text).toMatch(/did NOT run/);
    });

    it(`${file.name} warns that npx may run a stale global copy and says to check the version`, () => {
      const prose = file.text.replace(/\s+/g, " ");
      expect(prose).toContain("global install");
      expect(prose).toContain("npx --no-install @vaultcompass/intent-guard --version");
    });
  }

  it("documents only subcommands the published CLI has", () => {
    const subcommands = new Set<string>();
    for (const file of files) {
      for (const line of bashLines(file.text)) {
        if (line.startsWith(`${DOCUMENTED} `)) {
          subcommands.add(line.slice(DOCUMENTED.length + 1).split(/\s+/)[0]);
        }
      }
    }
    expect(subcommands.size).toBeGreaterThan(0);
    for (const sub of subcommands) {
      const res = spawnSync("node", [join(CLI_PACKAGE, "dist", "intent-guard.js"), sub, "--help"], {
        encoding: "utf8",
      });
      expect({ sub, status: res.status }).toEqual({ sub, status: 0 });
    }
  });

  it("exits non-zero with a message naming the package in a project that does not have it", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-skill-outside-"));
    writeFileSync(join(dir, "package.json"), '{ "name": "outside", "private": true }\n', "utf8");
    const res = runDocumented(dir, ["drift", "--help"]);
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain("Usage: intent-guard");
    expect(res.stderr).toMatch(/@vaultcompass\/intent-guard|ENOTCACHED|not found/);
  });

  it("runs the published CLI in a project that has it installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-guard-skill-installed-"));
    writeFileSync(
      join(dir, "package.json"),
      '{ "name": "installed", "private": true, "devDependencies": { "@vaultcompass/intent-guard": "*" } }\n',
      "utf8",
    );
    mkdirSync(join(dir, "node_modules", "@vaultcompass"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(CLI_PACKAGE, join(dir, "node_modules", "@vaultcompass", "intent-guard"), "dir");
    symlinkSync(
      join("..", "@vaultcompass", "intent-guard", "dist", "intent-guard.js"),
      join(dir, "node_modules", ".bin", "intent-guard"),
    );
    // npm marks a bin target executable when it installs a package; tsc's
    // output in this tree is not, so do what the install would.
    chmodSync(join(CLI_PACKAGE, "dist", "intent-guard.js"), 0o755);
    const res = runDocumented(dir, ["drift", "--help"]);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("intent-guard");
  });
});
