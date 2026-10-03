import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTrustBaseResolvable,
  readArchivedContractAtRef,
  readControlFileAtRef,
  readFileAtRef,
  TrustBaseError,
} from "../src/trust-base.js";

/**
 * Each git-calling function in trust-base refuses a ref that starts with a
 * dash itself, rather than relying on every caller to have checked first.
 * Git reads such a value as an option: "git show -Sxyz:./x" exits 0 with no
 * output, which a caller would read as an empty file.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function repoWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "intent-guard-trust-refs-"));
  temps.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "tester@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  mkdirSync(join(dir, ".intent-guard"), { recursive: true });
  writeFileSync(join(dir, ".intent-guard", "config.yaml"), "version: 1.0.0\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function refusal(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal, but the call returned");
}

describe("trust-base git calls refuse a dash-leading ref", () => {
  it("readFileAtRef", () => {
    const dir = repoWithConfig();
    const error = refusal(() => readFileAtRef(dir, "-Sxyz", ".intent-guard/config.yaml"));
    expect(error).toBeInstanceOf(TrustBaseError);
    expect(error.message).toContain("starts with a dash");
  });

  it("readControlFileAtRef (the ls-tree lookup)", () => {
    const dir = repoWithConfig();
    const error = refusal(() => readControlFileAtRef(dir, "-Sxyz", "config.yaml"));
    expect(error).toBeInstanceOf(TrustBaseError);
    expect(error.message).toContain("starts with a dash");
  });

  it("readArchivedContractAtRef", () => {
    const dir = repoWithConfig();
    const error = refusal(() => readArchivedContractAtRef(dir, "-Sxyz", "ic-20260101-aaaaaa"));
    expect(error).toBeInstanceOf(TrustBaseError);
    expect(error.message).toContain("starts with a dash");
  });

  it("assertTrustBaseResolvable (the rev-parse lookup)", () => {
    const dir = repoWithConfig();
    const error = refusal(() => assertTrustBaseResolvable(dir, "-Sxyz"));
    expect(error).toBeInstanceOf(TrustBaseError);
    expect(error.message).toContain("starts with a dash");
  });

  it("still reads an ordinary ref", () => {
    const dir = repoWithConfig();
    expect(readFileAtRef(dir, "main", ".intent-guard/config.yaml")).toBe("version: 1.0.0\n");
    expect(readControlFileAtRef(dir, "main", "config.yaml")?.text).toBe("version: 1.0.0\n");
  });
});

describe("a failed ls-tree is not an absent file", () => {
  it("throws when the ref's tree cannot be listed", () => {
    const dir = repoWithConfig();
    const tree = execFileSync("git", ["rev-parse", "main^{tree}"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    unlinkSync(join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    const error = refusal(() => readControlFileAtRef(dir, "main", "config.yaml"));
    expect(error).toBeInstanceOf(TrustBaseError);
    expect(error.message).toContain("Nothing was checked");
  });

  it("still returns null for a path the ref simply does not carry", () => {
    const dir = repoWithConfig();
    expect(readControlFileAtRef(dir, "main", "intent-contract.yaml")).toBeNull();
  });
});
