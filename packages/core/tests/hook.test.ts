import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  CONDUCTOR_HOOK_MARKER,
  installPreCommitHook,
  renderPreCommitHook,
} from "../src/hook.js";

function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-hook-"));
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

function realGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-hook-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Hook Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "hook@example.invalid"], {
    cwd: dir,
  });
  return dir;
}

describe("renderPreCommitHook", () => {
  it("is a self-contained script with the managed marker", () => {
    const script = renderPreCommitHook();
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain(CONDUCTOR_HOOK_MARKER);
    expect(script).toContain("intent-guard check --project . --staged");
    expect(script).not.toContain("integrations/");
  });

  it("includes vault-guard only when requested", () => {
    expect(renderPreCommitHook(false)).not.toContain("vault-guard");
    expect(renderPreCommitHook(true)).toContain("vault-guard scan --staged");
  });
});

describe("installPreCommitHook", () => {
  it("writes an executable hook into .git/hooks", () => {
    const dir = gitProject();
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(true);
    const contents = readFileSync(result.path, "utf8");
    expect(contents).toContain(CONDUCTOR_HOOK_MARKER);
    const mode = statSync(result.path).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it("refuses when not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-nogit-"));
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("not_a_git_repo");
  });

  it("does not clobber a foreign hook without --force", () => {
    const dir = gitProject();
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho custom\n", "utf8");
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("existing_hook_not_managed");
    expect(readFileSync(hookPath, "utf8")).toContain("echo custom");
  });

  it("overwrites a foreign hook with force", () => {
    const dir = gitProject();
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho custom\n", "utf8");
    const result = installPreCommitHook(dir, { force: true });
    expect(result.installed).toBe(true);
    expect(readFileSync(hookPath, "utf8")).toContain(CONDUCTOR_HOOK_MARKER);
  });

  it("re-installs its own managed hook idempotently", () => {
    const dir = gitProject();
    installPreCommitHook(dir);
    const result = installPreCommitHook(dir, { withVaultGuard: true });
    expect(result.installed).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain(
      "vault-guard scan --staged",
    );
  });

  it("localizes machine-wide core.hooksPath to .git/hooks by default", () => {
    const dir = realGitProject();
    const shared = mkdtempSync(join(tmpdir(), "shared-hooks-"));
    writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\necho shared\n", "utf8");
    execFileSync("git", ["config", "core.hooksPath", shared], { cwd: dir });

    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBe(true);
    expect(result.path).toBe(join(dir, ".git", "hooks", "pre-commit"));
    expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(readFileSync(join(shared, "pre-commit"), "utf8")).toContain("echo shared");

    const localPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(localPath).toBe(".git/hooks");
  });

  it("installs into an in-repo custom hooksPath without localizing", () => {
    const dir = realGitProject();
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });

    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBeFalsy();
    expect(existsSync(join(dir, ".githooks", "pre-commit"))).toBe(true);
    expect(readFileSync(join(dir, ".githooks", "pre-commit"), "utf8")).toContain(
      CONDUCTOR_HOOK_MARKER,
    );
  });

  it("names the shared hooks directory it stops using when it localizes", () => {
    const dir = realGitProject();
    const shared = mkdtempSync(join(tmpdir(), "shared-hooks-"));
    writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\necho shared\n", "utf8");
    execFileSync("git", ["config", "core.hooksPath", shared], { cwd: dir });

    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBe(true);
    expect(result.previousHooksPath).toBe(shared);
  });
});

// The 2026-11-06 audit's B3 and N1. A refused install changes nothing, a
// hook is the tool's own only by its header line, and a managed hook that
// was edited after install is refused rather than rewritten.
describe("installPreCommitHook refuses before it changes anything (2026-11-06 audit B3, N1)", () => {
  function localHooksPath(dir: string): string {
    try {
      return execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  }

  function sharedRepo(): { dir: string; shared: string; localHook: string } {
    const dir = realGitProject();
    const shared = mkdtempSync(join(tmpdir(), "shared-hooks-"));
    writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\necho shared\n", "utf8");
    execFileSync("git", ["config", "core.hooksPath", shared], { cwd: dir });
    return { dir, shared, localHook: join(dir, ".git", "hooks", "pre-commit") };
  }

  const FOREIGN = "#!/bin/sh\nnpx lint-staged || exit 1\n";

  it("leaves core.hooksPath and both hooks alone when a foreign local hook refuses the install", () => {
    // The control first: the same shape with no local hook does localize, so
    // localHooksPath reads the value install changes and localHook is the
    // file install writes.
    const control = sharedRepo();
    expect(localHooksPath(control.dir)).toBe(control.shared);
    expect(installPreCommitHook(control.dir).installed).toBe(true);
    expect(localHooksPath(control.dir)).toBe(".git/hooks");
    expect(readFileSync(control.localHook, "utf8")).toContain(CONDUCTOR_HOOK_MARKER);

    const { dir, shared, localHook } = sharedRepo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(localHook, FOREIGN, "utf8");
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("existing_hook_not_managed");
    expect(result.localizedHooksPath).toBeFalsy();
    expect(localHooksPath(dir)).toBe(shared);
    expect(readFileSync(localHook, "utf8")).toBe(FOREIGN);
    expect(readFileSync(join(shared, "pre-commit"), "utf8")).toBe("#!/bin/sh\necho shared\n");
  });

  it("treats a hook that only mentions the marker in a comment as foreign", () => {
    const dir = gitProject();
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    const foreign = `#!/bin/sh\n# not ${CONDUCTOR_HOOK_MARKER}, my own hook\nnpx lint-staged || exit 1\n`;
    writeFileSync(hookPath, foreign, "utf8");
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("existing_hook_not_managed");
    expect(readFileSync(hookPath, "utf8")).toBe(foreign);
  });

  it("refuses to rewrite a managed hook edited after install, and --force rewrites it and says so", () => {
    const dir = gitProject();
    const first = installPreCommitHook(dir);
    expect(first.installed).toBe(true);
    const edited = `${readFileSync(first.path, "utf8")}npx lint-staged || exit 1\n`;
    writeFileSync(first.path, edited, "utf8");

    const refused = installPreCommitHook(dir);
    expect(refused.installed).toBe(false);
    expect(refused.reason).toBe("managed_hook_edited");
    expect(readFileSync(first.path, "utf8")).toBe(edited);

    const forced = installPreCommitHook(dir, { force: true });
    expect(forced.installed).toBe(true);
    expect(forced.discardedEdits).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(renderPreCommitHook(false));
  });

  it("does not localize core.hooksPath when an edited managed local hook refuses the install", () => {
    const { dir, shared, localHook } = sharedRepo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const edited = `${renderPreCommitHook(false)}npx lint-staged || exit 1\n`;
    writeFileSync(localHook, edited, "utf8");
    const result = installPreCommitHook(dir);
    expect(result.reason).toBe("managed_hook_edited");
    expect(localHooksPath(dir)).toBe(shared);
    expect(readFileSync(localHook, "utf8")).toBe(edited);
  });

  it("reinstalls over an unedited managed hook idempotently, with or without vault-guard", () => {
    const dir = gitProject();
    const first = installPreCommitHook(dir);
    const again = installPreCommitHook(dir);
    expect(again.installed).toBe(true);
    expect(again.discardedEdits).toBeFalsy();
    expect(readFileSync(first.path, "utf8")).toBe(renderPreCommitHook(false));
    const paired = installPreCommitHook(dir, { withVaultGuard: true });
    expect(paired.installed).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(renderPreCommitHook(true));
    expect(installPreCommitHook(dir, { withVaultGuard: false }).installed).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(renderPreCommitHook(false));
  });

  // The review of the 2026-11-06 fix, N-A: a write that fails must change
  // nothing either. These need a directory chmod can make read-only for this
  // process. As root, or on a file system that ignores the mode, chmod does
  // not stop the write, so each test probes first and skips when it cannot
  // make the directory read-only.
  function makeReadOnly(dir: string): boolean {
    chmodSync(dir, 0o555);
    const probe = join(dir, ".write-probe");
    try {
      writeFileSync(probe, "", "utf8");
    } catch {
      return true;
    }
    rmSync(probe, { force: true });
    chmodSync(dir, 0o755);
    return false;
  }

  it("changes nothing when the hook cannot be written into a read-only hooks directory (review N-A)", (ctx) => {
    const { dir, shared, localHook } = sharedRepo();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    if (!makeReadOnly(hooksDir)) {
      ctx.skip("chmod cannot make a directory read-only for this process (root, or a mode-less file system)");
      return;
    }
    try {
      const result = installPreCommitHook(dir);
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("hook_write_failed");
      expect(result.localizedHooksPath).toBeFalsy();
      expect(localHooksPath(dir)).toBe(shared);
      expect(existsSync(localHook)).toBe(false);
    } finally {
      chmodSync(hooksDir, 0o755);
    }
    // The control: with the directory writable again the same repository
    // localizes and gets the hook, so the two reads above are the real ones.
    expect(installPreCommitHook(dir).installed).toBe(true);
    expect(localHooksPath(dir)).toBe(".git/hooks");
    expect(readFileSync(localHook, "utf8")).toBe(renderPreCommitHook(false));
  });

  it("changes nothing when --force cannot overwrite a read-only foreign hook (review N-A)", (ctx) => {
    const { dir, shared, localHook } = sharedRepo();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(localHook, FOREIGN, "utf8");
    chmodSync(localHook, 0o444);
    if (!makeReadOnly(hooksDir)) {
      chmodSync(localHook, 0o644);
      ctx.skip("chmod cannot make a directory read-only for this process (root, or a mode-less file system)");
      return;
    }
    try {
      const result = installPreCommitHook(dir, { force: true });
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("hook_write_failed");
      expect(localHooksPath(dir)).toBe(shared);
      expect(readFileSync(localHook, "utf8")).toBe(FOREIGN);
    } finally {
      chmodSync(hooksDir, 0o755);
      chmodSync(localHook, 0o644);
    }
  });

  it("takes the written hook back out when core.hooksPath cannot be localized (review N-A)", (ctx) => {
    const { dir, shared, localHook } = sharedRepo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    // git config writes .git/config.lock, so a read-only .git stops it while
    // .git/hooks stays writable.
    const gitDir = join(dir, ".git");
    if (!makeReadOnly(gitDir)) {
      ctx.skip("chmod cannot make a directory read-only for this process (root, or a mode-less file system)");
      return;
    }
    try {
      const result = installPreCommitHook(dir);
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("hooks_path_localize_failed");
      expect(localHooksPath(dir)).toBe(shared);
      expect(existsSync(localHook)).toBe(false);
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  it("puts a foreign hook back when --force wrote over it and core.hooksPath cannot be localized (review N-A)", (ctx) => {
    const { dir, shared, localHook } = sharedRepo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(localHook, FOREIGN, "utf8");
    const gitDir = join(dir, ".git");
    if (!makeReadOnly(gitDir)) {
      ctx.skip("chmod cannot make a directory read-only for this process (root, or a mode-less file system)");
      return;
    }
    try {
      const result = installPreCommitHook(dir, { force: true });
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("hooks_path_localize_failed");
      expect(localHooksPath(dir)).toBe(shared);
      expect(readFileSync(localHook, "utf8")).toBe(FOREIGN);
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  // The review of the 2026-11-06 fix, N-E: a managed hook whose line endings
  // or byte-order mark changed is still refused, under its own reason.
  it.each([
    ["CRLF line endings", (s: string) => s.replace(/\n/g, "\r\n")],
    ["a byte-order mark", (s: string) => `${String.fromCodePoint(0xfeff)}${s}`],
  ])("refuses a managed hook with %s as a line-ending difference, not as foreign", (_label, change) => {
    const dir = gitProject();
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    const changed = change(renderPreCommitHook(false));
    writeFileSync(hookPath, changed, "utf8");
    const result = installPreCommitHook(dir);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("managed_hook_line_endings");
    expect(readFileSync(hookPath, "utf8")).toBe(changed);
    const forced = installPreCommitHook(dir, { force: true });
    expect(forced.installed).toBe(true);
    expect(readFileSync(hookPath, "utf8")).toBe(renderPreCommitHook(false));
  });
});
