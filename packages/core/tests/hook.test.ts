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
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  CONDUCTOR_HOOK_MARKER,
  installPreCommitHook,
  renderPreCommitHook,
} from "../src/hook.js";
import { runDoctor } from "../src/doctor.js";

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

// The 2026-11-08 re-grade's N1. In a linked worktree `.git` is a file, so
// the hooks directory is not `.git/hooks` under the worktree: git keeps one
// hooks directory for every worktree, in the common git directory. Install
// and doctor ask git where it is.
describe("hook install and doctor in a linked worktree (2026-11-08 re-grade N1)", () => {
  // A main checkout with one commit and a linked worktree beside it.
  function linkedWorktree(): { main: string; linked: string } {
    const main = realGitProject();
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
    const linked = join(mkdtempSync(join(tmpdir(), "conductor-hook-wt-")), "linked");
    execFileSync("git", ["worktree", "add", "-q", linked, "-b", "side"], { cwd: main });
    return { main, linked };
  }

  function configuredHooksPath(dir: string): string {
    try {
      return execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: dir, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }

  // Where git itself runs hooks from in `dir`, as a real path.
  function gitHooksDir(dir: string): string {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: dir, encoding: "utf8" }).trim();
    return realpathSync(resolve(dir, out));
  }

  // A commit attempt in `dir` with no intent-guard or npx on PATH: the
  // managed hook, if git runs it, refuses with its own message.
  function commitWithBareHook(dir: string): { status: number | null; stderr: string } {
    const result = spawnSync("git", ["commit", "--allow-empty", "-m", "probe"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    return { status: result.status, stderr: result.stderr };
  }

  it("installs into the common hooks directory, where git runs it from the linked worktree", (ctx) => {
    const { main, linked } = linkedWorktree();
    if (configuredHooksPath(linked) !== "") {
      ctx.skip("a machine-wide core.hooksPath is set; this case is the default hooks directory");
      return;
    }
    const gitFile = readFileSync(join(linked, ".git"), "utf8");
    const result = installPreCommitHook(linked);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBeFalsy();
    expect(realpathSync(result.path)).toBe(join(realpathSync(join(main, ".git", "hooks")), "pre-commit"));
    expect(realpathSync(result.path)).toBe(join(gitHooksDir(linked), "pre-commit"));
    expect(readFileSync(result.path, "utf8")).toBe(renderPreCommitHook(false));
    expect(configuredHooksPath(linked)).toBe("");
    expect(readFileSync(join(linked, ".git"), "utf8")).toBe(gitFile);

    const commit = commitWithBareHook(linked);
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain("pre-commit: intent-guard not found on PATH");
    // A second install is the same unedited managed hook: idempotent.
    expect(installPreCommitHook(linked).installed).toBe(true);
  });

  it("lets doctor see the hook install wrote from the linked worktree", (ctx) => {
    const { linked } = linkedWorktree();
    if (configuredHooksPath(linked) !== "") {
      ctx.skip("a machine-wide core.hooksPath is set; this case is the default hooks directory");
      return;
    }
    expect(runDoctor(linked).findings.some((f) => f.id === "git_pre_commit_missing")).toBe(true);
    expect(installPreCommitHook(linked).installed).toBe(true);
    const after = runDoctor(linked).findings;
    expect(after.some((f) => f.id === "git_pre_commit_conductor")).toBe(true);
    expect(after.some((f) => f.id === "git_pre_commit_missing")).toBe(false);
  });

  it("refuses a foreign hook in the common hooks directory from the linked worktree", () => {
    const FOREIGN = "#!/bin/sh\nnpx lint-staged || exit 1\n";
    const { main, linked } = linkedWorktree();
    mkdirSync(join(main, ".git", "hooks"), { recursive: true });
    const hook = join(main, ".git", "hooks", "pre-commit");
    writeFileSync(hook, FOREIGN, "utf8");
    const result = installPreCommitHook(linked);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("existing_hook_not_managed");
    expect(readFileSync(hook, "utf8")).toBe(FOREIGN);
  });

  it("still installs into .git/hooks in the main checkout of the same repository", (ctx) => {
    const { main } = linkedWorktree();
    if (configuredHooksPath(main) !== "") {
      ctx.skip("a machine-wide core.hooksPath is set; this case is the default hooks directory");
      return;
    }
    const result = installPreCommitHook(main);
    expect(result.installed).toBe(true);
    expect(realpathSync(result.path)).toBe(join(realpathSync(join(main, ".git", "hooks")), "pre-commit"));
  });

  it("installs into an in-repo core.hooksPath of the linked worktree without localizing", () => {
    const { linked } = linkedWorktree();
    mkdirSync(join(linked, ".githooks"), { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: linked });
    const result = installPreCommitHook(linked);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBeFalsy();
    expect(existsSync(join(linked, ".githooks", "pre-commit"))).toBe(true);
    expect(configuredHooksPath(linked)).toBe(".githooks");
  });

  it("localizes a machine-wide core.hooksPath to the common hooks directory, which runs in both checkouts", () => {
    const { main, linked } = linkedWorktree();
    const shared = mkdtempSync(join(tmpdir(), "shared-hooks-"));
    writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\necho shared\n", "utf8");
    execFileSync("git", ["config", "core.hooksPath", shared], { cwd: main });

    const result = installPreCommitHook(linked);
    expect(result.installed).toBe(true);
    expect(result.localizedHooksPath).toBe(true);
    expect(result.previousHooksPath).toBe(shared);
    const common = realpathSync(join(main, ".git", "hooks"));
    expect(realpathSync(result.path)).toBe(join(common, "pre-commit"));
    expect(result.hooksPathSetTo).toBe(configuredHooksPath(linked));
    expect(readFileSync(join(shared, "pre-commit"), "utf8")).toBe("#!/bin/sh\necho shared\n");
    // The value git now reads names the common hooks directory from either
    // checkout, so the hook runs in both.
    expect(gitHooksDir(linked)).toBe(common);
    expect(gitHooksDir(main)).toBe(common);
    for (const dir of [linked, main]) {
      const commit = commitWithBareHook(dir);
      expect(commit.status, dir).not.toBe(0);
      expect(commit.stderr, dir).toContain("pre-commit: intent-guard not found on PATH");
    }
    // Installing again finds its own hooks directory configured: no second
    // localization, nothing named as no longer running.
    const again = installPreCommitHook(linked);
    expect(again.installed).toBe(true);
    expect(again.localizedHooksPath).toBeFalsy();
    expect(again.previousHooksPath).toBeUndefined();
  });

  it("names the real cause when the configured hooks directory cannot exist in the linked worktree", () => {
    // KNOWN GAP, pinned on purpose: this test pins the documented Not handled
    // refusal (installed false, core.hooksPath left as .git/hooks). It is not
    // a safety property. A fix that repairs a relative .git/hooks from a
    // linked worktree is meant to turn it red; rewrite it then.
    // A relative core.hooksPath of .git/hooks, as a main-checkout install
    // writes it, names a path inside the worktree's .git file.
    const { main, linked } = linkedWorktree();
    execFileSync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: main });
    const gitFile = readFileSync(join(linked, ".git"), "utf8");
    const result = installPreCommitHook(linked);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("hook_write_failed");
    expect(result.error).toMatch(/ENOTDIR|not a directory/);
    expect(result.error).not.toMatch(/read-only|EACCES|EPERM/);
    expect(readFileSync(join(linked, ".git"), "utf8")).toBe(gitFile);
    expect(configuredHooksPath(linked)).toBe(".git/hooks");
    expect(existsSync(join(main, ".git", "hooks", "pre-commit"))).toBe(false);
  });
});
