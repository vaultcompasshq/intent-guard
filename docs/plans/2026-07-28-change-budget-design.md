# Change Budget — Design (v1.1.0)

**Date:** 2026-07-28
**Status:** Approved, in implementation
**Branch:** `feat/change-budget`

## Motivation

Market research (July 2026) shows the AI-assisted-development field converging on
Conductor's premise ("we need intent review, not just code review") and settling
on one dominant, proven mechanism for preventing scope drift: a **change budget**
declared before execution and enforced by a **deterministic gate outside the
model** — "a prompt is not a boundary."

Canonical drift cases this addresses:

- Asked for "retry logic in one client," got a 14-file diff with a new interface,
  DI wiring, and bootstrap edits → `max_files` + `allowed_paths`.
- Agent "also fixed" a handler whose inconsistency was an intentional external
  contract → `protected_paths`.
- Agent added an unrequested dependency → `allow_new_dependencies: false`.

This also shores up an audited weakness: Conductor's enforcement gate (pre-commit
/ CI) only sees changed file **paths** (`git diff --cached --name-only`). The
Change Budget turns paths from a lexical accident into an intentional, deterministic
control — no LLM, no network, fully offline.

## Schema (additive, backward compatible)

New optional `budget` object on `IntentContract`. Absent `budget` = no budget
enforcement. Existing 1.0.x contracts stay valid; schema `version` const remains
`1.0.0` (optional additive field).

```yaml
budget:
  allowed_paths: ["packages/core/**"]   # work must stay inside these globs
  protected_paths: ["**/legacy/**"]     # never touch
  max_files: 10                         # cap on total changed files
  allow_new_dependencies: false         # flag manifest/lockfile edits
```

All four fields optional.

## Enforcement (`packages/core/src/budget.ts`)

`evaluateBudget(contract, changedPaths): BudgetResult` — deterministic, path-only,
using a small self-contained glob matcher (no new dependency; supports `*`, `**`,
`?`, plain segments).

| Rule | Condition | Severity |
|------|-----------|----------|
| `protected_paths` | any changed path matches | hard_block |
| `allowed_paths` | a changed path matches none of the globs | soft_block |
| `max_files` | changed-file count exceeds the cap | soft_block |
| `allow_new_dependencies: false` | a manifest/lockfile is edited | soft_block |

Manifest detection reuses the lockfile/manifest regex already in `drift.ts`.
The dependency rule is intentionally coarse: a path cannot distinguish add vs
bump vs remove, so any manifest edit flags. Documented as conservative-by-design.

`BudgetResult` shape:

```ts
interface BudgetViolation {
  rule: "protected_paths" | "allowed_paths" | "max_files" | "allow_new_dependencies";
  severity: "soft_block" | "hard_block";
  message: string;
  matched: string[];
}
interface BudgetResult {
  ok: boolean;
  violations: BudgetViolation[];
  action: "ok" | "soft_block" | "hard_block";
}
```

## Gate integration

`checkGate` evaluates the budget alongside drift when the frozen contract has a
`budget` and changed paths are present. Violations become gate `reasons` and set
the exit code; `GateResult` gains `budget?: BudgetResult`. Budget stays SEPARATE
from the 0-100 drift score (pass/fail, not fuzzy) so the two signals stay legible.
`report.ts` renders a Budget section.

## Out of scope for v1 (YAGNI / honesty)

- `allow_public_api_changes` — needs AST/content parsing; breaks the offline,
  path-only guarantee. Belongs with the deferred semantic path.
- `conductor budget set` CLI — budget is hand-authored in YAML for v1, documented
  with an example under `examples/`. A CLI is the natural follow-up.
- Config-level severity overrides — presence of `budget` in the contract is the
  opt-in; severities are fixed (protected = hard, others = soft) for v1.

## Also in this release

- Hygiene: README test count 127 → 150; CHANGELOG reorder + `[1.1.0]` section.
- Version bump: all four `@vaultcompass/conductor-*` packages + root to `1.1.0`;
  `scripts/release-smoke.mjs` expected version; CLI version test.

## Testing (TDD)

- schema: `budget` validates; optional; rejects bad types.
- `budget.ts`: one test per rule, clean-within-budget, and glob-matcher cases.
- gate: frozen contract + budget + staged paths → correct severity and exit code.
- report: Budget section rendered.
