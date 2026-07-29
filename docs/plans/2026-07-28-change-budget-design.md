# Change Budget design (v1.1.0)

**Date:** 2026-07-28
**Status:** implemented
**Branch:** `feat/change-budget`

## What it adds

An optional `budget` block on the Intent Contract that the gate checks against
the changed file paths. It is deterministic and path-only: no model, no network.
This is separate from the 0-100 drift score. Drift is a fuzzy score; the budget
is a plain pass/fail over paths.

The point is to make the paths an intentional control. Before this, the gate saw
changed paths but only matched them loosely against the prose in `out_of_scope`.
A budget lets a contract say plainly which paths are in bounds, which are off
limits, how many files a change may touch, and whether it may edit a dependency
manifest.

## Schema

`budget` is optional and additive, so existing contracts stay valid and the
schema `version` const stays `1.0.0`.

```yaml
budget:
  allowed_paths: ["src/payments/**"]   # work must stay inside these globs
  protected_paths: ["**/legacy/**"]    # never touch
  max_files: 5                         # cap on changed files
  allow_new_dependencies: false        # flag manifest/lockfile edits
```

## Rules

`evaluateBudget(contract, changedPaths)` in `packages/core/src/budget.ts`.

| Rule | Condition | Severity |
|------|-----------|----------|
| `protected_paths` | a changed path matches | hard_block |
| `allowed_paths` | a changed path matches none of the globs | soft_block |
| `max_files` | changed-file count over the cap | soft_block |
| `allow_new_dependencies: false` | a manifest/lockfile is edited | soft_block |

The glob matcher is self-contained (no dependency): `*` within a segment, `**`
across segments, `?` for one character, and a wildcard-free glob as a directory
prefix (so `src` covers everything under `src/`). The dependency rule is coarse
on purpose: a path cannot tell an add from a bump, so any manifest edit flags.

## Gate and report

`checkGate` runs the budget when the frozen contract has one and there are
changed paths. Violations become gate reasons and set the exit code, and
`GateResult` carries a `budget` field. `conductor report` prints a Change budget
section.

## Left out of this version

- `allow_public_api_changes`: reliably detecting a public API change needs to
  read file contents, which breaks the offline, path-only guarantee.
- A CLI to author the budget: for now it is written by hand in the contract
  YAML. There is an example at
  `examples/intent-contracts/retry-with-budget.yaml`.

## Tests

- `packages/core/tests/budget.test.ts`: the glob matcher and each rule.
- `packages/core/tests/gate-budget.test.ts`: a frozen contract with a budget
  through `checkGate`.
- `packages/schema/tests/validate.test.ts`: budget validation cases.

Dogfooded against public repos (`sindresorhus/is`, `chalk/chalk`) by injecting a
budget into a frozen contract and staging real changes. That run caught a bug
where a wildcard-free glob did not match a directory's contents, so a protected
directory failed to protect; fixed by the directory-prefix rule above.
