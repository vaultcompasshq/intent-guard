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
script that still calls them.

Renamed in 1.3.0: the per-project state directory is `.intent-guard/`, not
`.conductor/`. An existing `.conductor/` is read with a notice and renamed on
the first write; both present is a hard error. See
[docs/schemas/directory-layout.md](./schemas/directory-layout.md).

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

Out-of-scope and constraint matches are three-state. After tokenization (which
already drops stopwords), the overlap is scored as `strong`, `partial`, or
`none`. Category tokens from the path classifier (`source`, `readme`,
`documentation`, `metadata`, `dependency`, `manifest`, `api`, `endpoint`,
`test`) count as ordinary evidence: they only exist when a matching path
shape actually changed. A stopword alone can never trigger. Constraints also
strip `CONSTRAINT_NOISE_TOKENS` (the 1.0.5 false-positive guard) before
scoring. Slash-joined fragments in an item (`packages/cli`, `docs/`) match a
changed path by consecutive whole segments. An out-of-scope slash hit is
strong on its own. A constraint slash hit counts as one matched evidence
token and then goes through the coverage gate. `strong` is coverage of at
least `strong_coverage` (default 0.5) with at least one non-noise evidence
token. `partial` is coverage of at least `partial_coverage` (default 0.3).
Only `strong` findings increment the scope-creep or constraint score;
`partial` findings are recorded with a `possible` prefix and score 0. Both
thresholds live on `drift.thresholds` in `.intent-guard/config.yaml`. A
`strong` constraint match is capped at advisory instead, with no score
increment, when the constraint's `source` is a prose rules file (`CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, cursor rules). See `intent-guard check` below.

**An out_of_scope match whose only evidence is a file-name keyword is not
counted.** A rule "Do not change sync" and a changed
`src/components/SyncStatus.tsx` share only `sync`, from the file name, so the
finding is recorded as `partial` with "(file name only, not counted)" in its
message and scores 0. The demotion fires only when the file name is the
sole evidence. Any other evidence and the full strength counts, the name
tokens included: a directory segment (`src/middleware/auth.ts` against
"Never touch the auth middleware" is strong), a path-category token
(`package.json` is a manifest), a slash fragment the item writes out, a word
of the item that names the file under the closed file-name rule below, or a
match in `--signals`. The pre-commit hook (`check --staged`) and the GitHub
Action pass no `--signals`, so in those runs a changed path is the only
evidence there is.

**Constraints are never demoted.** A constraint's match keeps the strength
it had in 1.9.0, file name included: "Never modify billing" against
`src/billing.ts` and "Never edit the lockfile" against `pnpm-lock.yaml`
block.

**The closed file-name rule.** This is the rule an author can rely on to
guard a file by name. Each word of an out_of_scope item is reduced, until
it stops changing: backslashes become slashes; leading quotes, backticks,
brackets and braces, leading `./` and `../` prefixes or a lone `/`, a
trailing footnote or reference marker (`[^1]`, `[1]`), and trailing
punctuation are trimmed; and one layer of paired emphasis is removed per
step. A markdown link word gives both its text and its target, and a
`*.ext` glob wrapped in emphasis stars (`*.pem*`) gives the bare glob. So
``Never touch `Dockerfile`.``, `Never touch **Dockerfile**`,
`Never modify **payment**_methods`, `Never touch ./Dockerfile`,
`Never touch .\Dockerfile`, `Never touch {Dockerfile}`,
`Do not edit the [changelog](CHANGELOG.md).`,
`Never edit [CHANGELOG.md][1]` and `Never edit Dockerfile[^1]` each name
the file. A dunder name (`__init__.py`) is never emphasis-stripped, and a
home-directory path (`~/Dockerfile`) names nothing in the repository. The
word names a changed file when one of its forms is, case-sensitively:

- exactly the file's basename: `.env.local`, `.env.production`,
  `CODEOWNERS`, `Dockerfile`, `Makefile`, `LICENSE`, `id_rsa`,
  `schema.prisma`;
- exactly the basename without its final extension: `CHANGELOG` names
  `CHANGELOG.md`, `.env` names `.env.local`, `secrets` names
  `secrets.json`;
- a `*.ext` word whose extension ends the basename: `*.pem` names
  `server.pem`.

A slash path written in the item (`src/Dockerfile`, `src\Dockerfile`,
`config/.env.local.` at the end of a sentence, without the full stop)
matches as consecutive whole
path segments, separately from this rule.

Such a word makes the match a path match, so it is never demoted. Nothing
else about a file name is: a word found inside a longer name (`sync` in
`SyncStatus.tsx`) is not. A `protected_paths` budget is the firmer guard.

**Matchers are built from what a rule prohibits.** Leading negation markers
(No, Do not, Don't, Never, Must not, Should not, SHALL NOT, Cannot, Won't,
Avoid and their variants, stacked or not) are stripped before tokens are
taken, so "Don't modify billing" matches on `modify` and `billing`, not on
`don`. Only paired emphasis markers (`**x**`, `_x_`) and backticks are
removed; an underscore inside an identifier (`payment_methods`, `id_rsa`)
stays. The rule text itself is kept as written, in the contract and in the
finding.

**The ask never cancels a rule.** in_scope tokens are subtracted from each
item before matching, as before. The ask itself subtracts nothing: a token
of `original_ask` is subtracted only when no out_of_scope item or
constraint uses it, and every token drift scores a rule on is one that rule
uses, so no ask token can ever remove one (the proof is in
docs/INVARIANTS.md). So "Add a theme toggle. Keep the change small and never
touch billing." still blocks `src/billing/invoice.ts`. A bug description
that extraction reads as a prohibition ("never updated by sync") is not
cancelled either; delete it from the draft. To narrow a rule with agreed
scope, put the scope in `in_scope`.

A long prose rule cannot be matched lexically by a path: a 1-in-8 overlap
is none by design. Secrets and `.env` files are vault-guard's job, not a
filename special case here. Constraint-level path globs are the planned
answer for "this rule applies to these paths."

## intent-guard coach `<prompt text>` / intent-guard-coach `<prompt text>`

Scores a prompt for scope/clarity issues. JSON: `score`, `issues`,
`coaching`, `needs_coaching`. Never blocks.

## intent-guard extract / intent-guard-extract

Draft an Intent Contract from an ask. **Writes an UNFROZEN draft** -- approval is
separate (`intent-guard-freeze`).

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project (default `.`) |
| `--text "<ask>"` | the user's ask (required) |
| `--protected-path <glob>` | append a glob to `budget.protected_paths` (repeatable; syntax under [Glob syntax](#glob-syntax)) |
| `--dry-run` | print the draft JSON, write nothing |
| `--verbose` | on stderr, name each near-duplicate rule that a kept rule replaced |

Each `--protected-path` value must be a relative glob as git would print the
path: no leading slash, no backslash, no `..` segment, no `.` segment other
than a leading `./`, no surrounding whitespace, and it may not start with `-`
(so a following flag cannot be swallowed as the value). Only the wildcards
listed under [Glob syntax](#glob-syntax) are supported; a value with a brace
group or a character class is rejected here rather than frozen into a
contract where it would match nothing. Without `--protected-path`, the draft carries no
`budget` block at all -- a budget is otherwise authored by hand or produced by
`intent-guard import-spec` from a fenced yaml block in a superpowers spec (see
[Change budget](#change-budget)).

JSON: `valid`, `written_path`, `frozen` (always false), `next_step`,
`replaced`, `suggested_allowed_paths`, `prompt_score`, `needs_coaching`,
`coaching`, `contract_yaml`.

`original_ask` is the whole ask, whitespace folded. An ask longer than 500
characters (the schema's limit) keeps as many whole sentences as fit and
ends with ` ...`; only a first sentence that alone is too long is cut, at a
word boundary.

**Near-duplicate rules are merged.** Two rules merge when they are identical
once case, whitespace, punctuation and the leading negation marker are
folded ("Never touch billing." and "Do NOT touch billing"), or when one is a
prefix or a word-bounded part of the other and both carry the same drift
tokens ("PDF export" and "Do not add any PDF export"). The longer one is
kept, in the place of the one that came first. Constraints merge only with
the same polarity, so "Use the shared logger" and "Never use the shared
logger" both stay, and the kept constraint carries the higher priority. A
superset with words of its own is not a duplicate: "Do not touch billing"
stays beside "Do not touch billing (Stripe or Braintree) code", because
folding it in would lower drift coverage on a billing path from 0.5 to 0.25.
Every merge is listed in `replaced` (`kept`, `replaced`), and `--verbose`
prints each as `replaced: "<rule>" (kept "<rule>")`.

**Rules are read from whole paragraphs and list items.** In `AGENTS.md`,
`CLAUDE.md`, `GEMINI.md` and cursor rules, a hard line break inside a
paragraph is a space; a blank line, a heading, a list marker, a fence, a
table or a blockquote ends the unit, and each unit is judged once. A unit
longer than 300 characters (the schema's rule limit) is judged one whole
sentence at a time; an abbreviation such as "e.g.", "i.e." or "etc." ends no
sentence. A rule is never a fragment of a sentence. A line ending in a colon
that introduces a list ("You must follow these rules:") is not a rule; its
items are. YAML front matter is skipped.

**Path budget suggestions.** A token in the ask that looks like a path is
printed as a suggested `budget.allowed_paths` glob, on stderr as
`suggestion: budget.allowed_paths could be ... (not written; ...)` and in
`suggested_allowed_paths`. It is never written into the draft: add the ones
you want to the draft's budget before `freeze`. A token qualifies when it
contains a slash and ends in one, ends in a known extension, or starts with
a top-level directory of the project (`src/parser/` becomes `src/parser/**`);
when it has a known extension alone (`README.md`); or when it is exactly the
name of a top-level directory (`packages` becomes `packages/**`). A URL,
`read/write`, and anything the budget matcher could never match (a leading
`/`, a `..` segment, a brace) are not suggested.

## intent-guard import-spec / intent-guard-import-spec

Import Spec Kit, Kiro, or superpowers-style artifacts into an unfrozen Intent
Contract draft. This is a bridge into Intent Guard's approval flow, not a second
spec system: review the draft, edit if needed, then run `intent-guard freeze`.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--from auto\|spec-kit\|kiro\|superpowers` | source format; default `auto` |
| `--spec-dir <dir>` | explicit spec directory (spec-kit, kiro) |
| `--requirements <path>` | explicit requirements/spec/bugfix file |
| `--design <path>` | explicit design/plan file |
| `--tasks <path>` | explicit tasks file |
| `--spec <path>` | superpowers: the design spec markdown file |
| `--plan <path>` | superpowers: the plan markdown file |
| `--dry-run` | print the draft JSON, write nothing |
| `--verbose` | on stderr, name each near-duplicate item that a kept item replaced |

Discovery checks Spec Kit-style `specs/<feature>/spec.md`, `plan.md`,
`tasks.md` and `.specify/specs/<feature>/...`; Kiro-style
`.kiro/specs/<feature>/requirements.md` or `bugfix.md`, `design.md`, and
`tasks.md`; then superpowers-style `docs/superpowers/`. JSON includes `format`,
`spec_dir`, `imported_files`, `written_path`, `frozen: false`, `next_step`,
`review` (`notice`, `in_scope`, `out_of_scope`), `sections`, `warnings`,
`suggested_allowed_paths`, `replaced`, and `contract_yaml`. `original_ask`
is the importer's one-line header (`Import <format> spec "<label>" into an
Intent Guard Intent Contract.`), never the spec body. Near-duplicates merge
and path budgets are suggested exactly as for `extract`.

### Only labelled sections are read

`import-spec` reads only sections headed Scope, In scope, Out of scope,
Non-goals, Requirements, Constraints, Acceptance criteria or Success
criteria, and their common spellings: "Project scope", "Scope summary",
"Functional requirements", Kiro's "Requirement 1: Export", "Design
constraints", every out-of-scope spelling listed below (Not in scope, Won't,
Excluded, Deferred work, Future work), any case, numbering and a trailing
parenthetical ignored. "Requirements Document", the title Kiro gives a whole
file, is not one. A `#` heading's section runs to the next heading of the
same or a higher level, nested headings included; a bold or `Label:`
pseudo-heading covers the list under it. Everything else in the file (an
introduction, a background, a competitor survey, a design discussion, a
task list under a "Tasks" heading) is not read. `sections` lists each
section read as `<file>: <heading>`.

Inside a labelled section, Gherkin is dropped: a `Feature:`, `Scenario:`,
`Scenario Outline:`, `Background:`, `Examples:` or `Rule:` line and the
block under it, a `Scenario:` heading and its body, a run of steps that
opens with a title-case `Given`, and any step with a bold keyword
(`**Given** x, **When** y, **Then** z`). An upper-case EARS requirement
("WHEN x THE SYSTEM SHALL y") is a requirement and is kept, and so is a
prose line that merely starts with When. Table rows are dropped.

One exception: an explicit prohibition inside Gherkin is kept. A Then, And
or But step, or a non-step line of a scenario body, that says SHALL NOT,
MUST NOT, never, do not or don't (straight or curly apostrophe, any
spacing) is imported without the step keyword, split at semicolons: each
clause that carries a marker becomes its own `out_of_scope` item, from its
marker to the clause's first full stop, as if it were a bullet under an Out
of scope heading, and a clause with no marker is dropped ("Then the system
SHALL NOT email the file; SHALL NOT upload to the archive bucket" gives
both items). A comma does not end an item. An expected
outcome that uses a kept marker is imported too ("Then the customer is
never charged twice" gives "never charged twice"); reword it or delete the
item before `freeze`. Every other Gherkin line is dropped, including an
outcome written with no, cannot, can't, should not, will not, won't, avoid
or without ("Then no file is downloaded"): write a rule you want enforced
with one of the kept markers, or under an Out of scope heading. A Given or
When step is always dropped; when it carries a kept marker, `import-spec`
warns, naming the file and the step.

A spec with no labelled section at all yields an empty draft: no
`out_of_scope`, one placeholder `in_scope` item saying so, and one
placeholder acceptance criterion. A `warnings` entry, also printed on
stderr as `warning: ...`, names the files and the headings it looked for.
It is never a contract built from the whole file. Add one of those headings,
or write the contract by hand.

Every run also prints, on stderr, the line "Review each item; polarity is
inferred from headings and modals and may be wrong." followed by every
extracted `in_scope` and `out_of_scope` item, one per line. Read both lists
before `freeze`: an item in the wrong list either authorises what the spec
ruled out or forbids what it asked for.

### How imported text is sorted

Extraction reads the spec's structure, not only its sentences:

- **Out-of-scope sections.** Bullets and sentences under a heading named
  Non-goals, Out of scope, Not in scope, Won't (have), Will not, Excluded,
  Deferred work or Future work (any level, any case, numbering ignored, and
  also a bold line such as `**Out of scope:**` or a plain `Out of scope for
  this fix:` line) go to `out_of_scope` and never to `in_scope`. A sentence of
  the form "X is out of scope" also sends X to `out_of_scope`.
- **Section extent.** A `#` heading's section runs to the next heading of the
  same or a higher level. A child heading with no kind of its own is
  ordinary: it never inherits out-of-scope or problem from its parent, so a
  requirement nested under a Non-goals heading stays a requirement. A bold or
  colon pseudo-heading of either kind covers only the list right under it and
  closes at the first line that is not a bullet; a bold line with no kind
  ("**Acceptance criteria**") changes nothing.
- **Problem sections.** Under a heading named Problem, Problem statement,
  Background, Context, Current state, Current failures or Motivation, a bare
  "no X" or "never X" is a description of today, not a rule, and is dropped.
  An explicit prohibition there is still a rule: Do not, MUST NOT, SHALL NOT,
  should not, may not, a modal with never ("should never"), a clause that
  starts with Never, and "No X SHALL ...". The whole heading must be one of
  those words, so "Context items" is an ordinary section. Introduction is an
  ordinary section, because every Kiro requirements.md opens with one.
- **User stories.** A line labelled `User story:` is motivation ("As a
  contributor, I do not want ..."), not a rule, and yields no prohibition.
- **Tables** are skipped for every rule.
- **Modifier negations, judged per clause.** A sentence is split into
  clauses at a semicolon and at a comma that opens a negated clause
  ("MUST use the staging key, never the prod key"). In a clause with a
  positive modal (SHALL run, must use), a "with no X" where X is a resource
  the run goes without is a modifier, not a prohibition: "CI SHALL run, with
  no cloud credentials: terraform validate" forbids nothing. Every other
  shape stays a prohibition: a clause that starts with No or Never, one with
  an explicit negation, a coordinated "and never", a "no" that is the verb's
  own object ("SHALL show no wildcard Resource"), and a "with no" that names
  an action or a path ("with no writes to billing/"). When in doubt the
  prohibition is kept: a false one blocks loudly, a lost one passes silently.
- **Ranking and cap.** `out_of_scope` keeps at most 12 items, the contract
  schema's own limit, so a draft always validates. The routed non-goals come
  first, then explicit prohibitions (SHALL NOT, MUST NOT, should not, Do
  not, "No X SHALL ..."), then every other prohibition. On a long Kiro spec
  the list fills before every explicit rule fits, and the later ones are
  dropped, security rules included: read the list `import-spec` prints, and
  move the rules you need into the contract by hand before `freeze`.

The importer no longer appends its own "Do not treat the imported contract as
approved" sentence to the extracted text; on a spec with no prohibitions it
was the contract's only `out_of_scope` item. `intent-guard extract` applies
the same sorting to its input text; a prompt with no headings, tables or
labels extracts as before, apart from the modifier-negation rule and the
ranking.

### superpowers artifacts

A superpowers feature is two markdown files, not a directory of roles: a design
spec at `docs/superpowers/specs/<date>-<slug>-design.md` and a plan at
`docs/superpowers/plans/<date>-<slug>.md`. The spec is imported as
`requirements` and the plan as `tasks`. The `design` role stays empty unless
`--design` is passed, because the design reasoning already lives in the spec.

With no `--spec`, discovery takes the newest markdown file (by mtime) directly
under `docs/superpowers/specs`, then the plan in `docs/superpowers/plans` whose
filename stem matches, with a trailing `-design` stripped. The `-design` suffix
is optional; a repo that names both files identically pairs them too. A spec
with no matching plan imports on its own. `--plan` without `--spec` is an error:
a task list is not a contract.

`--spec` and `--plan` belong to this format alone. Combining either with
`--from spec-kit`, `--from kiro`, or `--spec-dir` is a usage error (exit 1)
rather than a silently ignored flag, since the contract would otherwise be built
from files the caller did not name.

Under `--from auto`, superpowers is checked **after** spec-kit and kiro, so a
repo with an existing layout resolves the way it always did.

`spec_dir` for this format is the `docs/superpowers` directory.

Two things to look for in the draft before freezing it. A plan's prose often
carries machine-specific absolute paths (a `Run: pnpm --dir /Users/...` line, for
example), and those land in the drafted contract verbatim, so scrub them during
review: `.intent-guard/intent-contract.yaml` is a committed file. And an
unterminated fence swallows the rest of the document, because the fence toggle
never flips back, so a plan with an unclosed block contributes nothing after it.

#### Budget block

If the spec or the plan contains a fenced yaml block whose entire content is a
single `budget` key, that value is validated against the contract schema and
attached to the draft as its change budget:

````markdown
```yaml
budget:
  allowed_paths: ["packages/core/src/online/**"]
  max_files: 12
```
````

Either fence delimiter works: ```` ``` ```` and `~~~` are both read, and a fence
is closed by its own delimiter. The spec is searched before the plan, and the
first such block wins. Any other yaml fence is ignored, so a document can show a
config or workflow sample without declaring a budget by accident. A `budget` block that does not validate
is an error naming the file it came from, never a silent skip: a budget that
quietly vanished would leave the gate open.

## intent-guard freeze / intent-guard-freeze

Approve a draft. A deliberate, attributable step -- an agent must not self-approve.

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

A constraint whose `source` is a prose rules file (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`, cursor rules) is advisory: a strong match is still reported, but
it never contributes to a blocking threshold, including after `intent-guard
freeze` writes it into the contract, because freezing does not change its
`source`. Only `source: user-stated` and a constraint added by `intent-guard
correct --promote` (which records `source: user-correction`) can block.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--staged` | auto-collect staged paths via `git diff --cached --name-only` |
| `--base <ref>` | auto-collect paths changed since the merge base with `<ref>`, via `git diff --name-only <ref>...HEAD` |
| `--trust-base <ref>` | pull-request mode: read every control input from `<ref>` |
| `--paths a,b` | explicit changed paths |
| `--signals "x,y"` | free-text descriptions of what changed (open vocabulary) |
| `--message "<text>"` | latest user message (pivot detection) |
| `--previous-contract <id>` | score current changes against an archived prior contract; informational only |
| `--no-require-frozen` | allow a missing contract (still scores drift) |
| `--json` / `--log` | JSON output / append to `drift-log.jsonl` |

Exit 0 = ok, 1 = blocked, 2 = could not run: `--base` or `--trust-base` would
not resolve or its value starts with a single dash such as `-S` (git would read
it as an option), a control file or an archived contract the trust base lists
could not be read, or `config.yaml` was refused by the schema.

A `--base` or `--trust-base` with no value, or whose value starts with `--`, is
a usage error instead: the value is read as missing, the usage text is printed,
and the exit code is 1, like any other usage error. Exit 1 therefore does not
always mean blocked; the usage text on stderr tells the two apart.

`--staged` and `--base` list a moved submodule pointer even when `.gitmodules`
or git config sets `ignore = all` for that submodule: both pass
`--ignore-submodules=none` to git. Every git call the CLI makes runs with
replace refs disabled (`GIT_NO_REPLACE_OBJECTS=1`, plus
`core.useReplaceRefs=false` through `GIT_CONFIG_COUNT`, which git reads from
2.31). On git 2.31 or newer, replace refs are disabled for every git call the
tool makes; on an older git only the environment variable applies, which
repository configuration can override, so git 2.31 or newer is required for
that protection.

### Checking a pull request with `--base`

`--staged` is the pre-commit view. `--base` is the pull-request view: the three
dot form asks what the branch changed since it forked, so commits that landed on
the base branch afterwards are not attributed to the branch.

`--base` is additive with `--paths` and `--staged`. The combined list is
de-duplicated and keeps first-seen order.

Git lists paths relative to the **repository root**, not to `--project`. When
`--project` points at a subdirectory of the repo, either run the gate from the
repository root or write the budget globs repo-relative, or nothing will match
(the wildcards themselves are listed under [Glob syntax](#glob-syntax)).

It fails closed. An unknown ref, a directory that is not a repository, a shallow
clone with no merge base, or a git that will not run all print one line to
stderr naming the ref and exit **2**. There is no silent fallback to an empty
path set, because an empty set makes the gate pass.

In GitHub Actions, `actions/checkout` fetches a single commit by default, so
there is no merge base to diff against. Either check out with `fetch-depth: 0`,
or fetch the base ref explicitly before running the gate:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: |
    npx --yes @vaultcompass/intent-guard@1.10.1 check --project . \
      --base origin/${{ github.base_ref }} \
      --trust-base origin/${{ github.base_ref }}
```

Pass `--trust-base` on every pull-request run; the next section says why.

When `--previous-contract` is provided, JSON includes `crossSessionDrift`;
this does not change the gate exit code.

### Pull-request mode with `--trust-base`

`--base` decides **which paths are judged**. `--trust-base` decides **where the
rules come from**. They are independent, and a pull-request run passes both:

```yaml
- run: |
    npx --yes @vaultcompass/intent-guard@1.10.1 check --project . \
      --base origin/${{ github.base_ref }} \
      --trust-base origin/${{ github.base_ref }}
```

The `vaultcompasshq/intent-guard` action builds exactly that command line and
decides both refs from the event, so a workflow using it cannot omit
`--trust-base` by forgetting to type it. See the
[README](../README.md#github-action).

Without it, the gate reads its contract and its config out of the branch it is
judging, so a pull request can widen `in_scope`, delete `protected_paths`,
write its own `frozen_by: user` and `approval`, and make the change all of
that forbade, in one commit. The gate agrees with the rewritten contract and
passes.

So that this shape is at least visible, a `check` or `report` run given
`--base` without `--trust-base`, whose changed set includes
`.intent-guard/intent-contract.yaml`, `.intent-guard/config.yaml`, or anything
under `.intent-guard/contracts/` (or the same under the legacy `.conductor/`),
prints a `warning:` line under the verdict naming each such file and telling
you to pass `--trust-base <ref>`. The warning is also in the JSON `warnings`
array. It never changes the status or the exit code: a push run on a protected
branch is a legitimate place to run `--base` alone.

With it, every control input comes from `<ref>` via `git show`, and the head
tree is the thing judged:

| Control input | Read from |
|---------------|-----------|
| `.intent-guard/intent-contract.yaml` | `<ref>` |
| `.intent-guard/config.yaml` | `<ref>` |
| `.intent-guard/contracts/<id>.yaml` (with `--previous-contract`) | `<ref>` |

Reads only. No checkout switch, no worktree, and nothing written into the
repository. `.conductor/` is tried after `.intent-guard/` at the base ref, so a
ref predating the 1.3.0 rename still resolves.

A control input the head changed **never takes effect** and is reported:

```
✓ Intent Guard gate: ok
  control inputs from: origin/main
  proposed: contract changed in this pull request
```

The `--json` output carries the same facts under `trustBase`:

```json
{"trustBase":{"ref":"origin/main","proposals":["contract changed in this pull request"],
  "contractChanged":true,"configChanged":false,"baseContractFound":true,"selfApproval":false}}
```

**The refusals.** Both fire only while the gate is enforcing a frozen contract,
so `--no-require-frozen` reports them and blocks on neither.

`Self-approval refused:` when the pull request both changes the contract and
gives it an approval that is not the base ref's. That is the attack: an
approval a pull request granted itself. A widening that leaves the approval
block alone is not refused; it is reported as a proposal and judged against the
base contract's scope and budgets.

`Control input refused:` when the pull request changed what the contract path
**is** rather than what the contract says: a symlink, a directory, a deletion,
or a change to the file's mode bits. A content comparison is blind to all of
these. Turning the contract into a link whose target holds the approved bytes
changes nothing any text comparison can see, and is the first half of a
two-step whose second half edits only the link target, in a pull request where
the contract path never appears in the diff at all.

Independently of this flag and of pull-request mode, the gate refuses to follow
a link at any of the three control paths: the contract file, the
`.intent-guard` directory itself, and `config.yaml`. That is what stops the
second half from landing on the trusted path, where pull-request mode is not in
play. A link at the directory level is the same trick one level up, and the
refusal has to cover it or the rule has a hole in it.

**A genuine re-freeze on a branch trips the self-approval refusal, by design.**
`intent-guard freeze` writes a new `approved_at`, so re-approving a widened
contract on the pull-request branch is indistinguishable, from the base ref, from
forging one. Two ways through, and there is no third:

1. Land the contract change on the base branch first, in its own pull request,
   then rebase the work onto it. The contract change gets reviewed as the change
   to the gate that it is.
2. Configure the human-approval add-on below, which lets a reviewer's approval
   stand in for the base ref's.

Until then the pull request shows drift against the old contract. That is the
intended surface: the work really is outside the scope anybody has approved yet.

**A `--trust-base` that resolves to the head commit is refused**, exit 2, even
though it names a real commit. Control inputs would come from the tree under
judgment, so the boundary would be off while the report said it was on. The
comparison is on resolved commits, not spellings, so a branch, a tag or a raw
SHA pointing at the head commit are all refused alike. The realistic way in is
`--trust-base ${{ github.sha }}`: on a `pull_request` event with the default
`actions/checkout`, that SHA is the merge commit, which is HEAD. Pass
`origin/${{ github.base_ref }}` instead. A branch with no commits ahead of its
base is refused by the same rule, which is not a case this can tell apart.

**A `--trust-base` whose TREE equals the head's is refused too**, exit 2, even
when it is a different commit. Two commits can carry one identical tree, and
then every control input still comes from the tree under judgment while a
commit comparison waves it through. This is the ordinary shape of a pull
request's merge ref: what GitHub publishes as `refs/pull/N/merge` is a merge
commit whose tree, when the base has not moved since the fork, *is* the head
branch's tree, and `actions/checkout` leaves that commit checked out. A
workflow passing `--trust-base ${{ github.event.pull_request.head.sha }}` then
names a different commit holding the same tree. Merging the base into the
branch changes the head's tree, so a pull request that does that is judged
normally rather than swallowed by this rule.

**No contract on the base ref** is first adoption, not an attack. The gate
reports no-contract exactly as it does outside pull-request mode, and names the
head's contract as a proposal.

It fails closed like `--base`: a ref that will not resolve, and a base
`config.yaml` the schema refuses, each print one line and exit **2**. A missing
base is never a reason to fall back to trusting the head.

Outside pull-request mode, behaviour is unchanged except for the link refusal
above. A pre-commit hook and a direct CLI run on a checkout you control are
already inside the trust boundary, and their output is byte for byte what it
was before this flag existed, for every control input that is a regular file at
the path it is named at.

#### Requiring a human approval as well (optional, workflow-level)

This is not a feature of this tool and there is no flag for it. It describes a
way of configuring your own repository with GitHub's own controls, written down
here because it composes with `--trust-base` and because the refusal above sends
readers looking for it.

Base-ref judgment is the floor and is not configurable. A team that has
reviewers can additionally require that a contract change carry a **human
approval** before it takes effect on merge: a required pull-request review, or a
CODEOWNERS entry for `.intent-guard/**` together with branch protection that
requires code-owner review. Those controls live in the repository's settings or
in a workflow on the protected base side, and none of them is ever read from a
file in the repository.

**Arrange for the workflow itself to be on the protected side.** For a
same-repo `pull_request` event GitHub runs the workflow file **from the pull
request head**, so a workflow that merely sits in `.github/workflows` is as
editable as any other file in the branch: a pull request can drop the
`--trust-base` argument, or the whole job, in the same commit that carries what
the gate would have caught. Nothing in this tool can see that, because the tool
is what was not run. Two ways to close it, and a repository needs one of them:

- Require the check by name in branch protection, so a pull request that
  removes the job cannot merge on a missing status; or
- Put the gate in a reusable workflow (or a composite action) held in a
  protected repository or on a protected ref, and call it with `uses:` so the
  steps that matter are not in the pull request's copy.

This is a repository-configuration step, not something a flag can do. Say it
out loud in your own setup docs, because "the workflow is on the protected
side" is an assumption every claim above rests on.

The reason is the whole point of this flag. A switch that selects between a
stricter and a weaker mode, stored in a file the pull request can edit, is not
a setting: the pull request picks the weaker mode, and the switch is the
vulnerability wearing a settings label. A control that can only tighten is safe
to offer from the protected side; one that can loosen is not safe anywhere the
pull request can reach. Teams with reviewers get better ergonomics from it too,
since an approved contract change can be allowed to settle the drift for that
pull request rather than waiting for the merge.

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

#### Glob syntax

This is the one description of the glob syntax; every other mention of a
glob in this reference and the README points here. The matcher is
`matchesGlob` in `packages/core/src/budget.ts`, and it understands exactly
three wildcards:

| Wildcard | Matches |
|----------|---------|
| `*` | any run of characters within one path segment (never `/`) |
| `**` | any number of whole segments; `src/**/x.ts` also matches `src/x.ts` |
| `?` | exactly one character within a segment |

A trailing `/**` covers everything under the directory **and the bare
directory path itself**: `vendor/pay/**` matches `vendor/pay/lib.ts` and
`vendor/pay`. The second form is how git lists a submodule pointer (a
gitlink), with no trailing slash and nothing under it, so a protected
`vendor/pay/**` blocks a moved submodule pointer at `vendor/pay`. The segment
boundary still holds: `vendor/pay/**` never matches `vendor/payments`,
`vendor/pay.txt` or `vendor/pay-old/x.ts`. Through 1.8.1 a trailing `/**`
required something after the slash, so a submodule at exactly the protected
root passed the gate.

The matcher is shared, so this applies to `allowed_paths` as well: an
`allowed_paths` entry `vendor/pay/**` now also allows a change listed as the
bare path `vendor/pay` (a moved submodule pointer, or a plain file named
exactly `vendor/pay`), which through 1.8.1 was reported as outside
`allowed_paths`.

A glob with no wildcard at all is treated as a directory prefix, so `src`
and `src/` both cover everything under `src/`, and an exact file path still
matches only itself. Globs are written repo-relative, as git prints paths,
and are case-sensitive.

Nothing else is a wildcard. Brace groups (`src/{a,b}/**`) and character
classes (`src/[ab]/**`) are not expanded: the matcher escapes `{`, `}`, `[`
and `]` as literal characters, so a glob written with either one matches only
a path that literally contains those characters. That is not "no path at
all": `app/[slug]/**` matches a directory literally named `[slug]`, which is
exactly how Next.js and SvelteKit name a dynamic-route directory, so a
protected path written that way is a real, working protection. A brace group
written as alternation (`src/{a,b}/**`) is the case that usually matches
nothing, because a directory literally named `{a,b}` is rare; write two
entries instead.

A `protected_paths` or `allowed_paths` entry that silently matches nothing is
a gate that silently protects nothing, so a value is checked wherever a
budget block can enter or leave a contract: rejected at `import-spec` and
`freeze`, warned about at `check` and `report` until 2.0.0, in two tiers:

- **Contract-level** (`intent-guard import-spec` and `intent-guard freeze` --
  the last gate before a hand-edited draft is trusted -- refuse a NEW entry
  with this shape, writing nothing. `intent-guard check` / `intent-guard
  report` warn about one on an already-frozen contract in 1.7.0, naming the
  entry and the reason and stating that it will block starting in `2.0.0`;
  they do not refuse it yet, so an upgrade never starts blocking on its own):
  non-empty, no leading slash, no backslash, no
  surrounding whitespace, no `..` segment, no stray `.` segment (anywhere but
  a leading `./`), not just `./` on its own, or `./` followed by any run of
  trailing slashes (`.//`, `.///`), all of which normalize to nothing, and no
  INTERNAL empty segment (`src//x`) -- a trailing one (`src//`) is accepted,
  because the matcher strips trailing slashes before comparing a no-wildcard
  glob, the same as it does for a single trailing slash (`src/`). A glob WITH
  a `*` or `?` must not end in `/` (`secrets/**/`): it is matched as written,
  no git path ends in `/`, and so the entry matches no file at all.
  A brace group, a character class, and a leading `-` are all accepted here,
  because a real git path can contain any of them.
- **Flag-level** (`intent-guard extract --protected-path` only): every
  contract-level rule above, plus no leading `-` and no brace group or
  character class. A value typed straight into a command-line flag is far
  more likely a typo or a shell-expansion mistake than an intended literal
  match, and a leading `-` would otherwise be read as the next flag (most
  concretely `--protected-path --dry-run`); a value that already made it into
  a contract through `import-spec` or a hand edit had a chance to be
  reviewed first.

Absent `budget` means no budget enforcement, so existing contracts are
unaffected. The
dependency rule is intentionally coarse: a path cannot tell an add from a bump,
so any manifest edit flags. Budget violations appear in `intent-guard check`
reasons and in the `intent-guard report` "Change budget" section. An invalid
`protected_paths` or `allowed_paths` entry on an already-frozen contract
appears instead in `intent-guard check`'s `warnings` (and its plain-text
`warning:` lines) and in the `intent-guard report` "Gate warnings" section,
neither of which affects the exit code in 1.7.0. See
[examples/intent-contracts/retry-with-budget.yaml](../examples/intent-contracts/retry-with-budget.yaml).

Notes:

- The budget is enforced by `intent-guard check` and `intent-guard report` (the gate).
  `intent-guard drift` is a score-only command and does not enforce the budget, so
  wire CI to `check`/`report` to match the pre-commit hook.
- Globs are case-sensitive, matching git's case-sensitive path tracking. On a
  case-insensitive filesystem a `Src` glob still will not match a staged
  `src/...` path.
- Changed paths come from git with `--no-renames`, so a deletion lists the
  deleted path and a rename lists **both** its old and its new path. Moving a
  file out of a protected directory therefore still blocks. The cost is that a
  rename counts as two paths against `max_files`.
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
| `--base <ref>` | auto-collect paths changed since the merge base with `<ref>`, exactly as `check --base` does |
| `--trust-base <ref>` | pull-request mode, exactly as `check --trust-base` does |
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

`--base` behaves exactly as it does for `check`, including the fail-closed exit
2 and the GitHub Actions checkout note above: `check` and `report` share one
path-collection module so the two commands cannot see different paths for the
same flags.

`--trust-base` also behaves exactly as it does for `check`, and adds a
**Pull-request mode** section at the top of the markdown naming the ref and
every control input the head proposes to change. The contract summarised is
the base ref's, because that is the one the gate judged against; summarising
the head's would print an approver's name the run deliberately ignored.

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

Checks include which state directory is in use and whether a legacy
`.conductor/` remains, `.intent-guard/config.yaml`, active contract validity, frozen
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
| `--trust-base <ref>` | take the drift thresholds from `<ref>` |
| `--ci` | unified CLI only; exit 1 when `block: true` |

JSON: `overall`, `action`, `categories`, `findings`, `message`, `block`.

`--trust-base` belongs here because `--ci` turns this score into an exit code,
and the thresholds that decide it live in `config.yaml`, which a pull request
can edit. Only the thresholds move to the base ref: the contract was named by
the caller with `--contract`, so it is already the caller's own choice on
either side. A changed config is noted on **stderr** so stdout stays parseable
JSON. A ref that will not resolve exits 2.

## Project config: `.intent-guard/config.yaml`

Validated on every load, not only by a validate subcommand. A file the schema
refuses prints one line naming the file and the key, and exits **2**, because
nothing was judged.

| Rule | Why |
|------|-----|
| drift thresholds are numbers from 0 to 100 | the drift score is capped at 100 and every band is tested with `>=`, so a band above 100 can never be entered and setting one is indistinguishable from turning the gate off |
| `hard_block_on_critical_constraints` is a boolean | a string `"false"` is truthy, so it used to mean the opposite of what it reads as |
| `drift.mode` is one of `handoff`, `file_write`, `every_turn` | anything else silently did nothing |
| unknown keys are refused, named by full path | a dropped key is a setting the user believes is in force and is not |

These are bounds on what a value may be, not on what a project may decide. A
team that only wants to block on maximum drift can still set every band to
100, and a team that trusts its own critical constraints can still turn
`hard_block_on_critical_constraints` off.

The path must also be a regular file: a symlinked `config.yaml`, like a
symlinked contract or a symlinked `.intent-guard` directory, is refused rather
than followed. The schema floors already bound what a linked config could do,
so this is the smaller of the two link risks, but one rule that holds for every
control input is easier to rely on than a rule with an exception nobody can
remember the shape of.

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
constraints, **acknowledged** corrections -- no failed code). Re-inject after a
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

Render or regenerate `.intent-guard/index.md` from real contract history, pivots,
constraints, and acknowledged corrections.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--write` | write `.intent-guard/index.md`; default prints markdown |
| `--json` | machine-readable output |

## intent-guard init / intent-guard-init

Create the `.intent-guard/` skeleton (`config.yaml`, `index.md`, `contracts/`).
An existing `.conductor/` from before 1.3.0 is renamed rather than duplicated.

| Flag | Meaning |
|------|---------|
| `--project <root>` | target project |
| `--json` | JSON output with `next_steps` (default) |
| `--human` | readable output with next-step hints |

JSON includes `state_dir`, `next_steps` with the recommended lifecycle commands
after init, and `gitignore_hint` saying what to commit and what to ignore.
