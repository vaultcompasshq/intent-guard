# CLI reference

The public entrypoint is the unified `intent-guard` binary in `packages/cli`.
Per-command bins ship alongside it from `packages/skill`.

```bash
pnpm build
pnpm intent-guard -- check --project . --staged        # root script form
# after package install:
intent-guard check --project . --staged
# per-command package bin:
intent-guard-check --project . --staged
```

Renamed in 1.2.0: the binary was `conductor` and the per-command bins were
`conductor-*` through 1.1.0. The old names are gone, so update any hook or
script that still calls them. The `.conductor/` project directory is unchanged.

The session lifecycle: **coach → extract/import-spec (draft) → freeze
(approve) → check (gate) → report/rules → pivot/correct → brief/resume**.

---

## Unified `intent-guard`

```bash
intent-guard --help
intent-guard --version
intent-guard <command> [flags]
intent-guard <command> --help
```

Commands: `init`, `coach`, `extract`, `import-spec`, `freeze`, `check`,
`report`, `rules`, `drift`, `correct`, `brief`, `doctor`, `hook`, `resume`,
`index`, `pivot`.

Every command accepts `--help` (and `-h`). Help prints usage to stdout and
exits `0` without doing any work: it never runs the gate, reads a contract, or
writes a file. `--help` is read as a flag, not as a flag's value, so
`intent-guard check --message --help` scores the literal message `--help` rather
than printing usage.

`intent-guard drift --ci` runs the lower-level drift scorer and exits `1` when the
JSON result has `block: true`; otherwise it preserves the normal command output.

## intent-guard coach `<prompt text>` / intent-guard-coach `<prompt text>`

Scores a prompt for scope/clarity issues. JSON: `score`, `issues`,
`coaching`, `needs_coaching`. Never blocks.

## intent-guard extract / intent-guard-extract

Draft an Intent Contract from an ask. **Writes an UNFROZEN draft** — approval is
separate (`intent-guard-freeze`).

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project (default `.`) |
| `--text "<ask>"` | the user's ask (required) |
| `--dry-run` | print the draft JSON, write nothing |

JSON: `valid`, `written_path`, `frozen` (always false), `next_step`,
`prompt_score`, `needs_coaching`, `coaching`, `contract_yaml`.

## intent-guard import-spec / intent-guard-import-spec

Import Spec Kit or Kiro-style artifacts into an unfrozen Intent Contract draft.
This is a bridge into Intent Guard's approval flow, not a second spec system:
review the draft, edit if needed, then run `intent-guard freeze`.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--from auto|spec-kit|kiro` | source format; default `auto` |
| `--spec-dir <dir>` | explicit spec directory |
| `--requirements <path>` | explicit requirements/spec/bugfix file |
| `--design <path>` | explicit design/plan file |
| `--tasks <path>` | explicit tasks file |
| `--dry-run` | print the draft JSON, write nothing |

Discovery checks Spec Kit-style `specs/<feature>/spec.md`, `plan.md`,
`tasks.md` and `.specify/specs/<feature>/...`; Kiro-style
`.kiro/specs/<feature>/requirements.md` or `bugfix.md`, `design.md`, and
`tasks.md`. JSON includes `format`, `spec_dir`, `imported_files`,
`written_path`, `frozen: false`, `next_step`, and `contract_yaml`.

## intent-guard freeze / intent-guard-freeze

Approve a draft. A deliberate, attributable step — an agent must not self-approve.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--approved-by "<name>"` | explicit approver (required when non-interactive) |
| `--yes` | skip the interactive prompt (records `method: forced`) |
| `--json` | machine-readable output |

Behavior: on a TTY, shows a summary and asks to confirm. Non-interactively,
**refuses unless `--approved-by` is given**. Records an `approval` block
(`approved_by` / `approved_at` / `method`). Idempotent if already frozen.

## intent-guard check / intent-guard-check (the gate)

Exits non-zero when no **approved** contract exists or staged changes drift past
a blocking threshold. Used by the pre-commit hook / CI.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--staged` | auto-collect staged paths via `git diff --cached --name-only` |
| `--paths a,b` | explicit changed paths |
| `--signals "x,y"` | free-text descriptions of what changed (open vocabulary) |
| `--message "<text>"` | latest user message (pivot detection) |
| `--previous-contract <id>` | score current changes against an archived prior contract; informational only |
| `--no-require-frozen` | allow a missing contract (still scores drift) |
| `--json` / `--log` | JSON output / append to `drift-log.jsonl` |

Exit 0 = ok, 1 = blocked.
When `--previous-contract` is provided, JSON includes `crossSessionDrift`;
this does not change the gate exit code.

### Change budget

If the frozen contract has an optional `budget` block, the gate also evaluates
it against the changed paths, deterministically and offline (no model, no
network). This is separate from the 0-100 drift score: it is a pass/fail
overlay computed from paths alone.

```yaml
budget:
  allowed_paths: ["src/payments/**"]   # work must stay inside these globs
  protected_paths: ["**/legacy/**"]    # never touch
  max_files: 5                         # cap on changed files
  allow_new_dependencies: false        # flag manifest/lockfile edits
```

| Rule | Condition | Severity |
|------|-----------|----------|
| `protected_paths` | any changed path matches | hard_block |
| `allowed_paths` | a changed path matches none of the globs | soft_block |
| `max_files` | changed-file count exceeds the cap | soft_block |
| `allow_new_dependencies: false` | a manifest/lockfile is edited | soft_block |

Globs support `*` (within a segment), `**` (across segments), and `?`. A glob
with no wildcard is treated as a directory prefix, so `src` and `src/` both
cover everything under `src/` (an exact file path still matches only itself).
Absent `budget` means no budget enforcement, so existing contracts are
unaffected. The
dependency rule is intentionally coarse: a path cannot tell an add from a bump,
so any manifest edit flags. Budget violations appear in `intent-guard check`
reasons and in the `intent-guard report` "Change budget" section. See
[examples/intent-contracts/retry-with-budget.yaml](../examples/intent-contracts/retry-with-budget.yaml).

Notes:

- The budget is enforced by `intent-guard check` and `intent-guard report` (the gate).
  `intent-guard drift` is a score-only command and does not enforce the budget, so
  wire CI to `check`/`report` to match the pre-commit hook.
- Globs are case-sensitive, matching git's case-sensitive path tracking. On a
  case-insensitive filesystem a `Src` glob still will not match a staged
  `src/...` path.
- Changed paths come from git, which lists deleted and renamed files, so a
  deleted protected file still blocks.
- The budget is evaluated against the current diff only. Cross-session
  comparison (`--previous-contract`) scores drift but does not re-check the
  budget.

## Finding fingerprints

Every finding Intent Guard emits in JSON carries a `fingerprint`: a deterministic
id for that finding. The same finding on the same input produces the same id on
every run and on every machine, so a baseline file can record "this one is
known" and a tool aggregating several guards can tell a repeat from something
new.

Where they appear:

- budget violations: `budget.violations[].fingerprint` (`intent-guard check --json`
  and `intent-guard report --json`);
- drift findings: `drift.finding_details[].fingerprint`, which pairs each
  human-readable `findings[]` string with its `category`, `rule_id`, and
  `matched` set. `findings[]` is unchanged and stays the prose rendering.
- `crossSessionDrift.findings` is prose only. Its fingerprinted form is
  `crossSessionDrift.previous.finding_details`, already keyed to the contract
  each finding was raised against.

The recipe, so other tools can reproduce an id without calling Intent Guard:

1. Take three inputs. The **contract id** (`contract_id` of the contract the
   finding was raised against), the **rule id** (the budget `rule` such as
   `protected_paths`; for drift, the `rule_id` field, which is the category, and
   for per-item findings the category plus the contract text that raised it),
   and the **matched set** (`matched`).
2. Normalize each matched entry: trim whitespace, convert `\` to `/`, drop a
   leading `./`. Discard empties, deduplicate, and sort by Unicode codepoint
   (not by locale).
3. Encode each field as `<length>:<value>`, where the length is the number of
   UTF-16 code units, and concatenate in this order: the literal recipe version
   `intent-guard.finding.v1`, the contract id, the rule id, the decimal count of
   matched entries, then each matched entry.
4. `sha256` that string as UTF-8; the fingerprint is the lowercase hex digest.

Length prefixes rather than a separator, because a separator lets content move
across a field boundary and collide: `("ab", "c")` and `("a", "bc")` would hash
the same under a plain join.

Nothing positional and nothing time-based is hashed. A finding's index in the
list, timestamps, run ids, the drift score, the constraint's priority, and the
human message text are all deliberately excluded: reordering findings is not a
new finding, the same problem found tomorrow is the same problem, and an id
that moved when a message was reworded would break every baseline on a copy
edit.

The recipe version is part of the hash. Changing the canonical form means
bumping `intent-guard.finding.v1`, which invalidates every stored id, so it is a
breaking change rather than a quiet edit. A pinned test vector in
`packages/core/tests/fingerprint.test.ts` fails if the recipe drifts.

## intent-guard report / intent-guard-report

Emit a reviewer-friendly handoff report for PRs, CI logs, or agent resumes.
It runs the same gate as `intent-guard check` and exits with the gate result.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--staged` | auto-collect staged paths via `git diff --cached --name-only` |
| `--paths a,b` | explicit changed paths |
| `--signals "x,y"` | free-text descriptions of what changed |
| `--message "<text>"` | latest user message |
| `--previous-contract <id>` | include prior-contract drift context |
| `--no-require-frozen` | allow a missing contract, matching `check` |
| `--with-secrets` | append optional vault-guard staged scan when installed |
| `--json` | machine-readable report |

Markdown includes the active contract, gate reasons, drift score, acceptance
criteria coverage inferred from paths/signals, pivots, corrections, changed
paths, signals, and a recommended next action.

With `--with-secrets`, the `vault_guard` block reports `blockingMatches` and a
`blocked` verdict taken from vault-guard's own `run.blocking_matches`, which
already honours the active `fail_on` threshold. The `secrets` count is every
match at any severity and is informational only, so do not gate on it: it
ignores the threshold and will disagree with vault-guard's own verdict.

## intent-guard rules audit / intent-guard-rules audit

Inspect project rule files and surface maintainability problems before they
become noisy task constraints.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | machine-readable output |

Sources: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`,
`.continue/rules`, and `.kiro/steering`. Findings include duplicate rules,
potential conflicts, stale or temporary wording, overbroad rules, and rules that
may deserve critical priority. The audit exits `0`; `status: warn` means the
maintainer should review findings.

## intent-guard doctor / intent-guard-doctor

Diagnose whether a project is ready to use Intent Guard before a gate fails.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | machine-readable output |

Checks include `.conductor/config.yaml`, active contract validity, frozen
approval state, archived contracts, generated index freshness, package version,
visible hook/workflow integrations, and optional vault-guard pairing signals.
Missing setup or an invalid/unfrozen contract exits `1`; warnings such as stale
index, foreign hooks it did not write, or a referenced vault-guard setup without a local
`vault-guard` binary exit `0`.

## intent-guard hook install / intent-guard-hook

Install a self-contained Git pre-commit hook that runs the enforcement gate on
staged changes. The generated hook resolves `intent-guard-check`/`intent-guard` (or
`npx`) at commit time and depends on no files from the Intent Guard source repo, so
it works from an `npx`/npm install.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project (must contain `.git`) |
| `--with-vault-guard` | also run `vault-guard scan --staged` in the hook |
| `--force` | overwrite an existing `pre-commit` hook Intent Guard did not write |
| `--json` / `--human` | output format (default JSON) |

Exits `1` when the target is not a git repo or a foreign hook exists without
`--force`. Re-installing a managed hook is idempotent. Bypass a single
commit with `git commit --no-verify`.

When `core.hooksPath` points **outside** this repository (machine-wide hooks),
install sets local `core.hooksPath=.git/hooks` and writes there so Git actually
runs the gate without overwriting a shared hooks directory. In-repo custom
paths such as `.githooks` receive the hook directly.

## intent-guard drift / intent-guard-drift

Scores drift for a given contract path (lower-level than `check`; does not gate
on contract presence).

| Flag | Meaning |
|------|---------|
| `--contract <path>` | contract YAML (required) |
| `--project <root>` · `--paths` · `--signals` · `--message` · `--log` | as above |
| `--ci` | unified CLI only; exit 1 when `block: true` |

JSON: `overall`, `action`, `categories`, `findings`, `message`, `block`.

## intent-guard correct / intent-guard-correct

Record a user correction as a durable lesson on the contract.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--wrong "<text>"` | what the agent did wrong (required) |
| `--right "<text>"` | the corrected approach (required) |
| `--rule "<text>"` | normalized negative rule (required) |
| `--acknowledge` | user-confirmed (authoritative); else `pending` |
| `--promote` | also add to `constraints[]` (requires `--acknowledge`) so drift-guard enforces it |

## intent-guard pivot / intent-guard-pivot

Record an intentional scope change and update the active contract through the
append-only `pivot_log`.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--change "<text>"` | pivot summary (required) |
| `--reason "<text>"` | why the pivot happened |
| `--add-scope "<text>"` | add an in-scope item; repeatable |
| `--remove-scope "<text>"` | remove an in-scope item; repeatable |
| `--add-out-of-scope "<text>"` | add an out-of-scope item; repeatable |
| `--acknowledge` | user-confirmed; else `pending` |

JSON: `written_path`, `index_path`, `pivot`, `pending`.

## intent-guard brief / intent-guard-brief

Emit the minimal correct-methodology context (intent, scope, AC, critical/high
constraints, **acknowledged** corrections — no failed code). Re-inject after a
context reset instead of replaying the transcript.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | machine-readable (default is markdown) |

## intent-guard resume / intent-guard-resume

Emit the current Session Brief plus recent prior contracts. Use at the start of
a resumed agent session after context compaction or a new day.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | machine-readable (`resume_markdown`) |

## intent-guard index / intent-guard-index

Render or regenerate `.conductor/index.md` from real contract history, pivots,
constraints, and acknowledged corrections.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--write` | write `.conductor/index.md`; default prints markdown |
| `--json` | machine-readable output |

## intent-guard init / intent-guard-init

Create the `.conductor/` skeleton (`config.yaml`, `index.md`, `contracts/`).

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | JSON output with `next_steps` (default) |
| `--human` | readable output with next-step hints |

JSON includes `next_steps` with the recommended lifecycle commands after init.
