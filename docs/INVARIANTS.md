# Invariants

Properties of the composite action and the public-repo hygiene gate, each
tied to the line that makes it true. This is not a complete list of the
repository. Open the cited line; the sentence is only as good as that line.

## The `version` input is an exact release, checked twice

The accepted shape is `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.
It is written in the input description at `action.yml:21`, and it is the
match at `action.yml:208` and again at `action.yml:278`. The second match
does not reuse `BASH_REMATCH` from the first: `action.yml:271` says the
array is read again on purpose. A leading-zero form does not match, which
is the point of `[1-9][0-9]*` rather than `[0-9]+`.

The drift check (`scripts/tests/action-hardening-drift.test.mjs`) parses
`action.yml`, takes the lines of every step's `run:` script, drops blank
lines and shell comments, and requires the whole line
`if [[ ! "${IG_VERSION}" =~ <shape> ]]; then` exactly twice. The copy in the
input description is not a `run:` line and does not count. Pinned by `goes
red when one of the version-shape lines is replaced by a commented copy` and
`goes red when the version-shape line gains a third copy`; every other pin
in that file has its own `goes red when this line is replaced by a commented
copy` test.

The default is `1.10.0` at `action.yml:41`.

## On a pull request, `version` may not pin older than this tag's scanner

`IG_TAG_SCANNER_MAJOR`, `IG_TAG_SCANNER_MINOR` and `IG_TAG_SCANNER_PATCH`
are `1`, `10` and `0` at `action.yml:257` through `action.yml:259`.
`IG_TAG_SCANNER` is assembled from those three at `action.yml:260`. The
comparison that refuses an older pin is `action.yml:300` through
`action.yml:307`, and the error that names both versions is
`action.yml:311`. The comparison runs only when `GITHUB_BASE_REF` is
non-empty (`action.yml:270`).

That constant is trusted only when the workflow names this action by owner
and ref (`vaultcompasshq/intent-guard@TAG`). A local-path reference, the
`./some/dir` form, reads `action.yml` out of the pull request's own tree, so
the constant is author-controlled and the rule protects nothing there.
`action.yml:251` through `action.yml:256` says so. Self-testing workflows
inside this repository are the usual reason to reference it that way. The
drift check pins the three assignment lines as executable lines, so a
comment that repeats `IG_TAG_SCANNER_MINOR=5` does not keep the pin green.

## npm older than 10.5.2 is refused before install

The floor is accept-only. `action.yml:559` accepts a major above 10.
`action.yml:561` accepts major 10, then `action.yml:562` accepts a minor
above 5, and `action.yml:564` accepts minor 5 with patch at least 2. Anything
else leaves `NPM_OK` at 0. The refusal text is `action.yml:570`: `npm 10.5.2
or newer`. The remediation is `action.yml:571`: Node 20.13.0 and later, and
22.1.0 and later, are fine; 22.0.0 ships npm 10.5.1.

README states the same floor at `README.md:291` and the same Node bound at
`README.md:294` through `README.md:295`. The drift check also pins the
remediation printf at `action.yml:571` as a whole `run:` line.

The drift check pins the four comparison lines (five comparisons) and the
printf carrying the `npm 10.5.2 or newer` sentence, each as a whole `run:`
line. The comment at `action.yml:511` says `OR NEWER` in capitals, and is a
comment, so it is not that sentence.

## The scanner is installed with `--ignore-scripts`

The install line is `action.yml:581`:

`npm install -g --ignore-scripts "@vaultcompass/intent-guard@${IG_VERSION}"`

The comment at `action.yml:575` names the flag. It is not that command. The
drift check pins the command.

## `npm audit signatures` runs in a subshell on the synthetic manifest

The invocation is `action.yml:623`:

`( cd "${npm_config_prefix}/lib" && npm audit signatures )`

`action.yml:514` and `action.yml:586` also contain the words `npm audit
signatures`. They are comments. The drift check pins the subshell, so those
comments do not keep it green. The synthetic manifest the command depends on
is written at `action.yml:596`.

## The action tag and the installed package can be different numbers

They are not right now: `README.md:289` pins `vaultcompasshq/intent-guard@v1.10.0`,
and `README.md:295` says that tag installs `@vaultcompass/intent-guard@1.10.0`,
because this release moved the action tag and the packages together. They
diverged briefly at 1.5.3, an action-only tag documented under the
CHANGELOG heading `[1.5.3] - 2026-09-20` that moved the workflow file without
publishing new packages; that same section still records that history,
naming `IG_TAG_SCANNER` as 1.5.2 on the 1.5.3 tag. The installed
version is the `version` input default at `action.yml:41`, the scanner
constant at `action.yml:257` through `action.yml:260`, and the package
version `1.10.0` in `package.json:4`, `packages/cli/package.json:3`,
`packages/core/package.json:3`, `packages/schema/package.json:3` and
`packages/skill/package.json:3`. Whenever a future action-only tag moves
`action.yml` without a package release, this section goes stale again the
same way, and the next package release is what re-converges it.

## Public repository hygiene is a lint, and CI runs it

`scripts/check-public-hygiene.mjs:20` through `scripts/check-public-hygiene.mjs:24`
name the union across dep-guard, vault-guard, intent-guard and conductor.
The dash rule is built from code points at `scripts/check-public-hygiene.mjs:85`
and applied at `scripts/check-public-hygiene.mjs:142`, before the allowlist
return at `scripts/check-public-hygiene.mjs:158`, so an allowlisted file is
not exempt from a non-ASCII dash. `package.json:11` wires the script as
`pnpm lint`. `.github/workflows/ci.yml:37` runs that script in the
build-test job.

## A bot co-author trailer fails the pull request

`.github/workflows/ci.yml:58` is the step `Refuse pull requests with bot
co-author trailers`. The pattern is `.github/workflows/ci.yml:66`.
`scripts/tests/coauthor-trailer.test.mjs` reads that pattern from the
executable line only, skipping lines that begin with `#`, and matches a
planted `cursoragent@cursor.com` trailer, a `noreply@anthropic.com` trailer,
and a `[bot]` trailer. A message with no trailer does not match. A comment
that copies the strong pattern does not keep the check green if the
executable line is weaker.

## Changed paths are collected NUL-separated

`packages/skill/src/changed-paths.ts:31` splits on NUL, and both git calls pass
`-z` (`packages/skill/src/changed-paths.ts:100` for `--staged`,
`packages/skill/src/changed-paths.ts:186` for `--base`). Without `-z`, git
C-quotes a name holding a double quote, backslash, tab or newline even with
`core.quotePath=false`, and the quoted string matches no protected glob. Pinned
by `packages/skill/tests/base-ref.test.ts`, the `NUL-separated path collection`
tests: `hard-blocks a double quote file name in a protected dir with --base`,
`... with --staged`, and the backslash and tab pairs of the same names. The
hook does the same, pinned by `passes a path with a double quote, a tab and
non-ASCII characters literally, and blocks on a backslash` and `passes a staged
backslash path to the gate through --staged` in
`examples/validate-integrations.test.ts`.

A newline in a name also has to match `**`. `packages/core/src/budget.ts:92`
builds the glob regexp with the `s` flag, so `.` (from `**`) matches a newline.
It is the only `RegExp` in `packages/*/src` built from a glob. Pinned by
`matches ** and * across a path containing a newline` in
`packages/core/tests/budget.test.ts`; by the `newline in a file name` tests in
`packages/skill/tests/base-ref.test.ts` (`hard-blocks --base`, `hard-blocks
--staged`, `hard-blocks --paths`, a staged rename and a committed rename out of
secrets/); and end to end through the hook by `blocks an untracked new file
with a newline in its name under secrets/`, `blocks a staged rename of such a
file out of secrets/` and `blocks a committed rename of such a file out of
secrets/` in `examples/validate-integrations.test.ts`.

`--staged` and `--base` never turn a git failure into an empty list.
`packages/skill/src/changed-paths.ts:56` raises `maxBuffer` to 256 MB (the 1 MB
default threw ENOBUFS, which used to pass), and `stagedPaths` returns empty only
when `git rev-parse --git-dir` says "not a git repository"
(`changed-paths.ts:71` through `:82`); every other failure exits 2
(`changed-paths.ts:115`). Pinned by `still blocks when the staged name list is
larger than 1 MB` (a real 1.3 MB list, not an injected size), `passes quietly
outside a git repository, as before` and `exits 2 on any other git failure`.

`--staged` and `--base` list a moved submodule pointer whatever `ignore`
setting the repository carries for it: both diffs pass
`--ignore-submodules=none` (`changed-paths.ts:98` and `changed-paths.ts:184`),
which overrides `.gitmodules` and git config alike. Pinned by the `a moved
submodule pointer is always listed` tests in
`packages/skill/tests/base-ref.test.ts`: `--base, when the branch sets ignore =
all and moves the pointer`, `--base, when the base already has ignore = all and
the branch only moves the pointer`, `--staged, with ignore = all in
.gitmodules` and `--staged, with diff.ignoreSubmodules = all in the repository
config`.

`--base` ends its revisions with `--` (`changed-paths.ts:190`), so a file named
like the range is not read as one. Pinned by `judges a branch that adds a file
named like the range it is diffed with`. `basePaths` refuses a ref that starts
with a dash itself, exit 2 (`changed-paths.ts:170` through `:174`), because git
reads `-Sxyz...HEAD` as an option and lists nothing. Pinned by `refuses a --base
value that starts with a dash (-Sxyz) as could-not-run` and its `-Gnomatch`,
`-O/dev/null`, `-p` and `-R` twins, by `refuses a dash-leading ref inside
basePaths itself, not only in the caller`, and for report by `refuses a --base
value that starts with a dash as could-not-run`, all in
`packages/skill/tests/base-ref.test.ts`. That refusal is exit 2 only for a
value with a single leading dash: the parser in `packages/skill/src/check-cli.ts`
reads a `--base` or `--trust-base` value that starts with `--` as a missing
value and answers with the usage text and exit 1, like any usage error.

## Every git call the TypeScript code makes runs with replace refs disabled

`gitSpawnEnv` (`packages/core/src/git-env.ts:22`) returns the environment for
every git child process the packages spawn: `GIT_NO_REPLACE_OBJECTS=1`, and
`core.useReplaceRefs=false` appended to the caller's `GIT_CONFIG_COUNT`
entries, so repository config cannot turn replace refs back on. No git
argument changes. It is passed as `env` at every `git` spawn in
`packages/skill/src/changed-paths.ts`, `packages/skill/src/freeze-cli.ts`,
`packages/core/src/trust-base.ts` and `packages/core/src/hook.ts`. A git older
than 2.31 ignores `GIT_CONFIG_COUNT`. On git 2.31 or newer, replace refs are
disabled for every git call the tool makes; on an older git only the first
variable applies, which repository configuration can override, so git 2.31 or
newer is required for that protection.
Pinned in `packages/skill/tests/base-ref.test.ts`, group `replace refs do not
change what the gate lists`: `--staged still lists a staged file when a
replace ref makes the cached diff empty`, `--staged still lists it when
repository config turns replace refs on` (red with only the first variable
set) and `--base still lists a committed file when a replace ref shows the tip
as the base`; all three go red with the environment removed from the helper.

## A trust-base read is never redirected by a dash or a file name

Every git call in `packages/core/src/trust-base.ts` that takes a ref refuses
one that starts with a dash before git sees it (`refuseDashRef` at
`trust-base.ts:101`, called at `trust-base.ts:120` for rev-parse,
`trust-base.ts:244` for show and `trust-base.ts:301` for ls-tree), with a
`TrustBaseError`, which every CLI turns into exit 2. Pinned by the `trust-base
git calls refuse a dash-leading ref` tests in
`packages/core/tests/trust-base-refs.test.ts` and by `refuses a --trust-base
value that starts with a dash, by name` in
`packages/skill/tests/trust-base.test.ts`.

`git show` ends its revision with `--` (`trust-base.ts:246`), so a file in the
tree named like `main:./.intent-guard/config.yaml` does not make the read fail.
A control file or archived contract that `ls-tree` lists but `git show` cannot
read is a `TrustBaseError` (`readListedBlob` at `trust-base.ts:360`, used at
`trust-base.ts:346` and `trust-base.ts:653`), never empty text and never "no
such file". So is an `ls-tree` that exits non-zero (`trust-base.ts:310`
through `:314`); only a listing that succeeds and names nothing means the base
carries no such file. Pinned in `packages/skill/tests/trust-base.test.ts`,
group `a file named like a revision does not change a trusted read`: `reads the
base config, not the defaults, when the head adds a file named after it`,
`reads the base contract when the head adds a file named after it`, `reads the
head control files when the head adds files named after them`, `reads an
archived contract at the base when the head adds a file named after it`, `is
could-not-run when a control file is listed at the base but cannot be read` and
`is could-not-run when the base tree cannot be listed at all`; and in
`packages/core/tests/trust-base-refs.test.ts` by `throws when the ref's tree
cannot be listed`, with `still returns null for a path the ref simply does not
carry` guarding the absent case.

## The Stop hook judges untracked and session-committed work, and fails closed

What the Stop hook hands the gate is built by `intent_guard_gate_args`
(`integrations/hooks/conductor-lib.sh:402`). Committed work since the baseline
travels through the gate's own `--base` and staged work through its own
`--staged` (`conductor-lib.sh:458`), which read git with `-z`. The hook itself
lists only unstaged edits (`conductor-lib.sh:464`) and untracked files
(`conductor-lib.sh:465`), with `-z`, minus what the other two channels carry
(`conductor-lib.sh:462` and `:463`, subtracted by `intent_guard_subtract_sorted`
at `conductor-lib.sh:356`), and passes them as `--paths`, each as `./<path>`
(`conductor-lib.sh:320`) so a leading `-` is not read as a flag, in arguments
under `INTENT_GUARD_PATHS_CHUNK_BYTES` (`conductor-lib.sh:375`, 96 KiB). With
the empty tree as the baseline, where git refuses a three-dot range, every path
goes through `--paths` instead (`conductor-lib.sh:444` through `:452`). A git
failure returns non-zero (`conductor-lib.sh:247`), and so does a failed sort
of the listings (`conductor-lib.sh:480` through `:487`);
`conductor-stop-check.sh:97` routes either to `could_not_run` rather than an
empty list. Pinned in `examples/validate-integrations.test.ts` by `judges an
untracked new file`, `judges work committed since the session began`, `does not
judge work committed before the session began`, `sends committed and staged
work through --base and --staged, not --paths`, `does not repeat in --paths a
path the other two channels already carry`, `splits a long --paths list into
repeated arguments, each under 128 KiB`, `judges against an empty-tree baseline
record with the real gate`, `fails closed with a clear message when git cannot
list the changes`, `is could-not-run, not an empty list, when sorting the
changed paths fails`, `adds a leading ./ to every path so a name starting with
a dash is not read as a flag` and `does not block the stop on a dash-prefixed
name with the real gate`.

`intent_guard_path_reason` (`conductor-lib.sh:281`, under `LC_ALL=C`) names
three shapes a `--paths` entry cannot take: a comma, a backslash, and a
trailing `/` (an untracked directory holding its own repository). A list
longer than `intent_guard_paths_budget` (`conductor-lib.sh:381`, at most 256
KiB) is the fourth (`conductor-lib.sh:494`). The Stop check runs the gate on
the rest and names each one on stderr.

On the normal route, where only unstaged and untracked paths cross the
command line, such a path is a finding: the Stop check blocks
(`conductor-stop-check.sh:202` through `:204`) whatever the gate said, and
with no gate binary too (`conductor-stop-check.sh:184` and `:185`). Pinned in
the `stop hook loop policy` group by
`still blocks on a comma in an untracked path when stop_hook_active is true`,
`still blocks on a backslash in an untracked path, with the real gate when
stop_hook_active is true`, `judges the rest of the change when a comma path is
present (real gate)`, `judges the rest of the change when a backslash path is
present (real gate)`, `judges committed work when a comma path is present (real
gate)`, `passes neither unpassable path to the gate, and blocks though the gate
passed`, `blocks on an unpassable path even when the gate itself exits 2`,
`blocks on an unpassable path even when no gate binary resolves`, `clears the
block on an edited comma file once it is staged, even after a rename`, `blocks
every time on an untracked directory that holds its own repository` and `blocks
every time when the untracked list is too long to pass, and clears once
staged`; by `refuses a path containing a comma instead of splitting it`; and by
`sees a backslash that is the trail byte of a Shift-JIS character` in the
`stop hook path classification` group, which runs only where the `ja_JP.SJIS`
locale is installed.

On the empty-tree route (`INTENT_GUARD_ALL_IN_PATHS`, set at
`conductor-lib.sh:448`), committed and staged paths cross the command line
too, so such a path is could-not-run instead: once the gate has passed what
it was given, `unpassable_verdict` (`conductor-stop-check.sh:159`, reached at
`:217`) calls `could_not_run`, and the message says which paths were not
judged and that a new session after the first commit restores full judging.
The loud pass claims no more than was judged: when a `--paths` argument
reached the gate it says the gate judged and passed only the paths it was
given (`:171`); when none did (the whole list too long, or no path passable)
the gate was handed nothing, and it says that NOTHING in the change was
judged and how to get it judged (`:174`). A finding from the gate on this
route still blocks every time (`conductor-stop-check.sh:207` through `:209`,
before `:217`). Pinned in the `stop hook with an empty-tree baseline` group by
`still blocks a finding every time when a comma file is committed beside it`,
`blocks once on a committed comma file, then lets the active stop through
loudly` (which asserts the some-paths message), `blocks once on a list too
long to pass, then lets the active stop through loudly`, `says NOTHING was
judged when no path at all could be passed, though a protected file is
committed` and `hands the gate no path at all when the whole list is too
long`.

Every diff the hook makes passes `--ignore-submodules=none`, except the
work-tree diffs, which pass `untracked` (`conductor-lib.sh:450`, `:451`,
`:462` through `:464`). `conductor-lib.sh:19` exports
`GIT_NO_REPLACE_OBJECTS=1`, and `conductor-lib.sh:25` through `:31` add
`core.useReplaceRefs=false` to the environment's `GIT_CONFIG_COUNT` entries,
after any already there, for every git call the hooks make and for the gate
they run. Revisions are ended with `--` (`conductor-lib.sh:450`, `:451` and
`:462`). Pinned in the `stop hook and repository git settings` group by `blocks
a pointer move committed during the session under ignore = all`, `blocks a
staged pointer move under ignore = all`, `blocks a pointer move not yet staged
under ignore = all`, `blocks an edit to a tracked file inside the submodule
checkout`, `blocks a committed pointer move under diff.ignoreSubmodules = all in
config`, `does not block on untracked build output inside a submodule checkout`
and `judges a committed change that a replace object maps onto the baseline`,
`judges a replaced commit even when repository config turns replace refs on`,
`keeps any git config the host already passes through the environment` and
`judges committed work when a file is named like the baseline range` (the
`--` at `conductor-lib.sh:462`); and by `judges a file named exactly like the
session baseline commit id`.

Stop hook loop policy, exactly. On the normal route a path the hook cannot
pass blocks first (above). Then the gate's exit status is split at
`conductor-stop-check.sh:207`: status 1 is a finding and always blocks
(`lifecycle_block`, exit 2), regardless of `stop_hook_active`; any other
non-zero status is could-not-run (`conductor-stop-check.sh:212`). Every
could-not-run condition (gate exit 2 or 127, no binary at `:187`, path
collection failure at `:97`, an unpassable path on the empty-tree route at
`:171` and `:174`, an unusable baseline at `:220`) calls `could_not_run` (`:60`): with
`stop_hook_active` not true (read at `:17` through `:23`, absent or
unparseable counts as not true) it blocks with exit 2, and with it true it
exits 0 (`:69`) after writing the cause and "CI `--base` is the enforcement
boundary" to stderr and a `systemMessage` JSON object to stdout (`:68`),
escaped by `intent_guard_json_escape` (`conductor-lib.sh:38`), which turns
every control character into a space.
Stdout is empty on a pass and on every block. Pinned by `blocks the stop when
the gate exits 2` and `blocks the stop when the gate exits 127`; by the `stop
hook loop policy` group, per could-not-run class: `blocks on <class> when
stop_hook_active is false`, `blocks on <class> when the field is absent or
unparseable`, `allows the stop with a loud message on <class> when
stop_hook_active is true`; with `still blocks a finding when stop_hook_active is
true (stub gate exits 1)` and `still blocks a real budget hard_block when
stop_hook_active is true` for findings; and by `parses when the message carries
control characters`.

The session baseline is written by `conductor-session-start.sh:27` through
`intent_guard_record_session_start` (`conductor-lib.sh:146`), which reads the
host's `source` (`conductor-session-start.sh:24`). `startup` and `clear` always
record a fresh baseline (`conductor-lib.sh:154`), first removing anything at
the record path that is not a regular file (`conductor-lib.sh:158` and
`:159`). Any other source, or none, leaves a record that exists untouched,
valid or not, and writes one only when there is none (`conductor-lib.sh:163`);
no contract id is compared. Pinned by `replaces a record path that is not a
regular file on a new session`, and by
`starts a fresh baseline on a new session (source startup), so a human commit
between sessions is not judged` (and the `clear` twin), `keeps the session
baseline when SessionStart fires again with source resume` (and `compact`,
`absent`), `keeps the session baseline when the contract id changes`, and in the
`baseline record across SessionStart sources` group by `leaves an invalid record
untouched on SessionStart with source <source>`, `keeps the old baseline when
the contract id changes before SessionStart with source <source>` and `writes a
record when none exists, on SessionStart with source <source>`, for `resume`,
`compact` and `absent`, and by `says to start a new session, not to run /clear,
about an invalid record`.

`intent_guard_baseline_valid` (`conductor-lib.sh:120`) accepts a recorded ref
only if it is a full object id naming the empty tree or a commit that is an
ancestor of HEAD. When it is not, or when there is no record and no upstream,
`intent_guard_baseline_ref` (`conductor-lib.sh:205`) returns 3 with a fallback
ref, the upstream or HEAD (`intent_guard_fallback_ref`, `conductor-lib.sh:185`).
The Stop check then judges staged, unstaged and untracked changes against it; a
finding there blocks every time, and only if nothing blocks is the unjudged
committed part reported through `could_not_run` (`conductor-stop-check.sh:204`
through `:206`). Pinned by the `baseline record integrity` tests (`refuses a
record that points at a tree, such as HEAD^{tree}`, `refuses a record that is a
name rather than an object id, such as HEAD`, `refuses a record for a commit
that is not an ancestor of HEAD`, `refuses a garbage record`, `accepts the empty
tree, the widest baseline`), by `blocks with no session-start record and no
upstream, and still judges the uncommitted work`, and in the `judging what can be judged without a usable baseline`
group by `blocks a finding in untracked work every time when the record is
invalid (real gate)`, `blocks a finding in staged work every time with no
record and no upstream (real gate)`, `judges the index, the work tree and
untracked files against HEAD when the record is invalid` and `reports the
committed part as not judged once the rest passes, and lets the second stop
through`. The operator escape `INTENT_GUARD_NO_BASELINE_OK=1` (`INTENT_GUARD_NO_BASELINE_OK=1
falls back to HEAD with a warning`) and the upstream stand-in (`with no record
but an upstream branch, judges changes since the upstream`) are unchanged.

A finding from the gate blocks every stop, whatever `stop_hook_active` says,
and so does a path the hook cannot pass on the normal route: both branches
call `lifecycle_block` with no check of it (`conductor-stop-check.sh:187`
through `:189` and `:192` through `:194`), and a collection that falls back
from an unusable baseline still runs the gate before anything is reported as
could-not-run.

`allow_new_dependencies` sees manifests under directories with a newline in
their name and does not mistake `x` NEWLINE `package.json` for one. Pinned by
`still sees a manifest inside a directory whose name contains a newline` and
`does not treat a file named like a manifest with a newline prefix as one` in
`packages/core/tests/budget.test.ts`.

These hooks are a tripwire, not a boundary: the baseline file is writable by the
agent, and re-pointing it at a newer ancestor commit is not detectable. CI with
`--base` and `--trust-base` is the enforcement boundary.

## The hook runs the in-repo dist only on an operator opt-in

`integrations/hooks/conductor-lib.sh:60` uses `packages/skill/dist` only when the
hook's environment has `INTENT_GUARD_DEV_DIST=1`; otherwise it resolves the binary
on `PATH`. Nothing in the repository can set it (an earlier design keyed on the
root `package.json` name, which an agent can rename in the same edit that plants
the dist). Pinned by `does not run a planted in-repo dist by default`, `does not
run a planted dist when package.json is renamed to intent-guard`, `does not run
a planted dist when there is no package.json at all` and `runs the in-repo dist
only when the operator sets INTENT_GUARD_DEV_DIST=1` in
`examples/validate-integrations.test.ts`. An operator who sets the variable
trusts a gitignored dist the agent may be able to write.

## Explicit changed paths are refused when they could dodge a glob

`packages/skill/src/changed-paths.ts:220` calls `explicitPathIssue`
(`changed-paths.ts:128`) on every `--paths` entry and exits 2 (`changed-paths.ts:225`)
for a `..` segment, a `.` segment anywhere other than the one accepted leading
`./`, an empty segment (`a//b`, `.//x`), a leading `/`, or a backslash. They are
refused, not normalized, because `src/../secrets/k` never matched `secrets/**`
while naming a protected file. intent-guard's own git reads (`--staged`,
`--base`) are not subject to this. A caller that forwards paths through `--paths`
must read git with `-z` and never forward git's C-quoted form, which would
otherwise reach the budget quoted and match no glob. The shipped GitHub
Actions samples (`integrations/github-actions/*.yml.sample`) forward no
`--paths` list: they pass `--base`, so the gate lists the change itself;
`ships a GitHub Actions gate CI sample` in
`examples/validate-integrations.test.ts` asserts both samples carry `--base`
and neither `--paths` nor `--name-only`. Pinned in
`packages/skill/tests/base-ref.test.ts` by `refuses a --paths entry with a ..
segment instead of letting it slip past a protected glob`, `refuses a leading ..
segment too, in report`, and the `explicit path shapes are refused like budget
globs` tests (`refuses a leading ./ followed by another . segment`, `refuses an
empty segment after ./`, `refuses an internal empty segment`, `refuses a leading
slash`, `refuses a backslash`); `still accepts a name that merely contains dots`
and `still accepts a single leading ./ and a trailing slash` guard against
over-refusing.

## The action does not write its JSON result under `.github/`

The validate step takes the first segment of `json-output` that is neither
empty nor `.` (`action.yml:378` through `action.yml:385`), strips its
trailing dots and spaces (`action.yml:388` through `action.yml:390`), and
refuses it when, lower-cased, it is `.github` (`action.yml:391` and
`action.yml:392`), so `./.github/x`, `.//.github/x`, `.GITHUB/x` and
`.github./x` are refused like `.github/x`. Before the run step creates any
directory (`action.yml:747`), it walks every component of the path under the
workspace, the target included, and refuses the write when one is a symlink
(`action.yml:734` through `action.yml:742`).
Pinned in `examples/validate-action.test.ts` by `refuses the same directory
spelled another way`, `refuses to write through a symlinked directory the
checkout carries` and `refuses to write through a symlink at the target path
itself`; `still accepts a path that only starts with the same letters` guards
against over-refusing.

## A wildcard budget glob may not end in `/`

`validateBudgetGlob` refuses a glob that contains `*` or `?` and ends in `/`
(`packages/core/src/budget-paths.ts:81`). Such a glob is matched as written,
and no git path ends in `/`, so it matches no file. `freeze` and `import-spec`
refuse it; `check` and `report` warn on an already-frozen contract that
carries one, saying it protects nothing, on the same path to blocking in
2.0.0 as the other contract-level rules. Pinned by `rejects a wildcard glob
that ends in '/', which no git path can match` in
`packages/core/tests/budget-paths.test.ts`, `refuses to freeze a contract whose
protected_paths carries a wildcard glob ending in '/'` in
`packages/core/tests/freeze-budget-paths.test.ts`, and `warns without blocking
when a frozen contract carries a wildcard glob ending in '/', and says it
protects nothing` in `packages/core/tests/gate-budget.test.ts`.

## The shipped Actions samples read the rules from the base

Both `integrations/github-actions/*.yml.sample` files pass `--base
"origin/$BASE_REF"` and `--trust-base "origin/$BASE_REF"`
(`conductor-drift-ci.yml.sample:63`, `conductor-vault-guard-ci.yml.sample:60`)
and pin an exact intent-guard version rather than `@latest`
(`conductor-drift-ci.yml.sample:60`, `conductor-vault-guard-ci.yml.sample:57`).
`ships a GitHub Actions gate CI sample` in
`examples/validate-integrations.test.ts` asserts both flags and the absence of
`guard@latest`. `pins every intent-guard version in the samples to the action
default, and vault-guard to one version` in the same file parses every
`intent-guard@` reference in both samples (the install line, the check step
and the comment naming the action tag) and requires each to equal the
`version` default in `action.yml`, so a release that bumps one and not the
other goes red. vault-guard has no default in this repository to follow: the
same test only requires every `vault-guard@` pin in the paired sample and in
`integrations/github-actions/README.md` to be one exact release.

## `check --base` without `--trust-base` names an edited control file

When a run has `--base` and no `--trust-base`, and the changed set includes
`.intent-guard/intent-contract.yaml`, `.intent-guard/config.yaml` or a path
under `.intent-guard/contracts/` (or the legacy `.conductor/` equivalents,
`packages/core/src/gate.ts:102`), the gate adds a warning naming each file
and the missing flag (`packages/core/src/gate.ts:172` through
`packages/core/src/gate.ts:174`, wording at `packages/core/src/gate.ts:122`).
A warning never changes the status or exit code. Pinned in
`packages/skill/tests/base-ref.test.ts` by `warns, naming the contract and
the flag, and keeps the exit code`, `carries the same warning in --json`,
`names config.yaml too`, `names an edited contracts archive entry too`,
`still blocks the same change with --trust-base, and does not warn there`,
and `does not warn when the change leaves every control file alone`; the
legacy directory, the archive in both directories, a `--project`
subdirectory, and the paths that must NOT count are pinned in
`packages/core/tests/gate-control-paths.test.ts`.

## A trailing `/**` covers the bare directory path

`matchesGlob` compiles a trailing `/**` after a directory as that directory
OR anything under it (`packages/core/src/budget.ts:79`), because git lists a
submodule pointer as the bare path. The slash stays mandatory before anything
further. Pinned in `packages/core/tests/budget.test.ts` by `matches the bare
root of a trailing /** (a submodule gitlink path)` and `does not stretch a
trailing /** past the segment boundary`, and end to end, with a real
submodule at the protected root, in `packages/skill/tests/base-ref.test.ts`
by `--staged, when the pointer is moved and staged` and `--base HEAD~1, after
the moved pointer is committed`.

## Spec extraction is heading-aware

`segmentForExtraction` (`packages/core/src/extract.ts:780`) runs before any
clause is parsed. Out-of-scope headings (`packages/core/src/extract.ts:549`
and `packages/core/src/extract.ts:551`) route their bullets and sentences to
`out_of_scope` only. A child heading with no kind of its own is neutral, and a
classified bold or colon pseudo-heading covers only the list under it
(`packages/core/src/extract.ts:810`). In a problem section
(`packages/core/src/extract.ts:560`; Introduction is not one) only explicit
prohibitions survive (`packages/core/src/extract.ts:690`, applied at
`packages/core/src/extract.ts:864`). User story lines yield no prohibitions
(`packages/core/src/extract.ts:869`). Table rows are skipped
(`packages/core/src/extract.ts:816`). The positive-modal exemption is judged
per clause (`packages/core/src/extract.ts:696`) and covers only a "with no
<resource>" phrase (`packages/core/src/extract.ts:717`,
`packages/core/src/extract.ts:737`). out_of_scope is ranked routed non-goals,
then explicit prohibitions, then the rest, and capped at the schema's 12
(`packages/core/src/extract.ts:935`, `packages/core/src/extract.ts:986`);
pinned by `ranks routed non-goals first, then explicit prohibitions, then the
rest`. At that cap a long spec can lose explicit rules past the twelfth item;
see the CHANGELOG known limits.
import-spec keeps heading markers and opens each file with a level-1 heading
so a section never crosses a file boundary
(`packages/core/src/spec-bridge.ts:779`). Pinned in
`packages/core/tests/extract-headings.test.ts` (every rule has its own
`describe`, and `every prohibition the base build kept is still kept` runs the
2026-10-13 reviewer probe cases against the base build's recorded output) and
in `packages/core/tests/spec-bridge.test.ts` by `routes a Kiro Non-goals
section to out_of_scope, never to in_scope`, `ends a section at the file
boundary, so the next file is not swallowed`, and `does not turn the
importer's own review reminder into an out_of_scope item`.

This makes polarity right more often; it does not make it verified.
`import-spec` prints every item with a review notice
(`packages/skill/src/import-spec-cli.ts:192`, pinned by `lists every extracted
in_scope and out_of_scope item with a polarity warning` in
`packages/skill/tests/cli.test.ts`).

## A rule is never a sentence fragment

`extractConstraintsFromMarkdown` judges units from `markdownUnits`
(`packages/core/src/constraints.ts:231`), never physical lines: a line that
is not blank, a heading, a fence, a list marker or a switch into or out of a
table or blockquote continues the open unit
(`packages/core/src/constraints.ts:283`). A unit over the schema's
300-character rule limit is judged one whole sentence at a time
(`packages/core/src/constraints.ts:343`), and an abbreviation such as "e.g."
ends no sentence. A unit ending in a colon right before a list is not a rule
(`packages/core/src/constraints.ts:336`). So every rule is a whole paragraph,
a whole list item, or a whole sentence of one. Pinned in
`packages/core/tests/extraction-review-fixes.test.ts` by `does not turn an
intro line ending in a colon before a list into a rule` and `does not end a
sentence at e.g. when splitting a long paragraph`, and in
`packages/core/tests/extraction-quality.test.ts` by `joins a hard-wrapped
paragraph into one rule, never a fragment`, `joins a wrapped list item and
keeps the next item separate`, `does not mark the continuation line of a
wrapped rule critical on its own` and `splits a paragraph too long to be one
rule into whole sentences only`.

Near-duplicates merge in `dedupeBy` (`packages/core/src/constraints.ts:94`)
only with the same polarity (`packages/core/src/constraints.ts:110`), and a
superset absorbs a rule only when both carry the same drift tokens
(`packages/core/src/constraints.ts:113`), because folding a narrower rule into
a wider one lowers drift coverage. Pinned by `never merges rules of opposite
polarity` and `keeps both when the superset has words of its own, so the
narrower matcher survives`.

## import-spec never builds a contract from unlabelled text

`selectLabelledSections` (`packages/core/src/spec-bridge.ts:631`) passes on
only the lines of labelled sections (`isLabelledScopeHeading`,
`packages/core/src/extract.ts:602`, over `LABELLED_SCOPE_RE` at
`packages/core/src/extract.ts:591` and the out-of-scope spellings); every
other line is dropped (`packages/core/src/spec-bridge.ts:707`), and a file
with no labelled section contributes nothing
(`packages/core/src/spec-bridge.ts:766`; pinned by `does not read an
unlabelled file whole beside a labelled one`). Inside a
section, table rows (`packages/core/src/spec-bridge.ts:709`) and Gherkin
scenarios and steps (`packages/core/src/spec-bridge.ts:684`,
`packages/core/src/spec-bridge.ts:714`) are dropped, except that a Gherkin
line carrying an explicit prohibition marker is kept (next paragraph). With
no labelled section in any file, the draft is emptied to one placeholder
in_scope item, no out_of_scope and one placeholder acceptance criterion, and
a warning names the headings looked for
(`packages/core/src/spec-bridge.ts:830`;
printed at `packages/skill/src/import-spec-cli.ts:193`). Pinned in
`packages/core/tests/extraction-quality.test.ts` by `ignores prose outside a
labelled section, such as a competitor survey` and `yields an empty contract
and a warning naming the headings it looked for when nothing is labelled`,
and in `packages/skill/tests/extraction-quality-cli.test.ts` by `warns on
stderr and in JSON, names the headings, and lists the sections it read`.

An explicit prohibition written as a Gherkin line is never dropped.
`gherkinProhibitions` (`packages/core/src/spec-bridge.ts:579`) keeps a Then,
And or But step, or a non-step line of a scenario body, when it carries one
of the markers in `EXPLICIT_PROHIBITION_MARKERS`
(`packages/core/src/prohibition-markers.ts:14`: SHALL NOT, MUST NOT, never,
do not, don't), matched after `normalizeMarkerText`
(`packages/core/src/prohibition-markers.ts:26`: curly apostrophes and
whitespace runs). `fromMarker` (`packages/core/src/spec-bridge.ts:549`)
normalises the kept line and splits it at semicolons; every clause that
carries a marker is kept as its own rule, cut at its own first marker, so
no subject in front of a marker becomes an in_scope item, and a clause with
no marker is dropped. Through the third fix round only the first clause was
kept, which lost "it must never call the ledger service" after a semicolon,
a rule 1.9.0 enforced (the review's g7). A Given or When step is always dropped, and so is an outcome written
with no, cannot, can't, should not, will not, won't, avoid or without; a
dropped Given or When step that carries a marker becomes an import warning
(`packages/core/src/spec-bridge.ts:795`, added at
`packages/core/src/spec-bridge.ts:828`). 1.10.0 dropped every Gherkin line,
which turned "Then the system SHALL NOT email the file" from a block in
1.9.0 into a pass.

Kept lines are routed by heading, never by extraction re-reading their
marker: each file's kept lines are emitted as bullets under a level-1
`GHERKIN_RULES_HEADING` ("Out of scope",
`packages/core/src/spec-bridge.ts:577`, emitted at
`packages/core/src/spec-bridge.ts:732`), the same path a spec's own Out of
scope section takes, and `routedItemsFrom` (`packages/core/src/extract.ts:656`)
keeps each bullet's first sentence. The second fix round instead relied on
extraction reading the marker again, which needed a mid-sentence don't
pattern in extraction; that pattern blocked an ask such as "Add a mobile
toolbar. Users don't see the export button on mobile today." against
`src/export/button.ts` (1.9.0 and 1.10.0 pass it), and is reverted:
extraction's out_of_scope markers are the 1.10.0 list again.

No out_of_scope capture crosses a line. `expandProhibitionLists`
(`packages/core/src/extract.ts:357`) reads the list after a prohibition verb
with `[^.!?\n]` and spaces and tabs only; with `[^.!?]` a comma list on one
line swallowed the prohibition on the next, which was then deduped away
(the 2026-10-18 review's g3). `extractOutOfScope`
(`packages/core/src/extract.ts:463`) uses a space-and-tab tail as well, but
that change is defence in depth: its patterns run on `splitSentences`
output, which is already split at newlines, and restoring `\s` there leaves
every test green by construction.

Pinned in `packages/core/tests/extraction-quality.test.ts` by `keeps an
explicit prohibition written as a Then or And step, as out_of_scope`, `keeps
an explicit prohibition in a scenario heading's body and in a bold Then
step`, `still imports nothing from a scenario whose steps are all positive`,
`drops a Given or When step even when it says never`, `drops a bold When
segment that says never and keeps the Then segment of the same line`, `warns,
naming the step, when it drops a Given or When step that carries a
prohibition marker`, every case of `routes a kept Gherkin Then step with
... to out_of_scope, never to in_scope` (19 marker spellings with the
expected kept set written out in the test, not derived from the marker
module, in a spec with bullets and in one without; the keep must accept
exactly that set), every case of `imports each kept Gherkin line as its own
out_of_scope item and blocks on it` (the review's g1, g3 and g4), `routes
kept Gherkin lines through an Out of scope section, not through prohibition
re-extraction`, every case of `keeps every marked clause of a kept line
split at semicolons, so %s blocks` (the review's g7, four paths), `keeps a
kept line's marked clauses only, so a following positive clause is not
forbidden`, `keeps the 1.10.0 out_of_scope reading of
an ask with a mid-sentence don't` and `keeps the prohibition on the next line
its own item when a comma list ends a line`; and end to end in
`packages/cli/tests/intent-guard.test.ts` by `imports Then SHALL NOT and And
must never as out_of_scope, and check blocks on them`.

Mutations run on 2026-10-18. First round: making `gherkinProhibitions`
return nothing turns the two keep tests red; keeping Given and When steps
turns `drops a Given or When step even when it says never` and `strips plain
Given, When, Then, And and But steps from a labelled section` red; removing
the marker filter turns `strips a scenario heading and its body from a
labelled section`, `strips a Feature block from a labelled section` and
`still imports nothing from a scenario whose steps are all positive` red.
Second round (those that still apply to the code as it stands): a local
keep list that adds "will not" turns the "will not" case red; not cutting
kept text at the marker turns all 12 kept-marker cases of the no-bullet
spec red; removing the Given and When check from the bold-step branch turns
`drops a bold When segment ...` and the warning test red; dropping the
warnings turns the warning test red. Third round: making
`normalizeMarkerText` a no-op turns 11 cases red (both shapes of `SHALL
NOT` with two spaces, must and not with a tab, `Do` and not with two spaces,
and both curly don'ts, plus the g1 case); emitting kept lines in place
instead of under the Out of scope heading turns the three straight and
curly don't bullet-shape cases, the g1 case and the routing test red;
restoring `[^.!?]` and `\s+` in `expandProhibitionLists` turns `keeps the
prohibition on the next line its own item ...` red. Fourth round: keeping
only the first semicolon clause turns all four g7 cases red; keeping a
marker-less clause too turns the four g7 cases and `keeps a kept line's
marked clauses only ...` red.

Known open: on the first fix round a kept And line also became an
acceptance criterion ("the exporter must never write to the audit log"), as
in 1.9.0. Kept lines now sit in an Out of scope section, which extraction
does not read acceptance criteria from, and the g1, g3 and g4 cases assert
that no acceptance criterion carries a kept line; but no mutation has been
shown to turn that assertion red on its own, so this stays open.

Path budgets an ask names are suggested only, never written: the
suggestion is computed at `packages/core/src/spec-bridge.ts:859` and printed
at `packages/skill/src/extract-cli.ts:149`; pinned by `never writes a
suggestion into the draft` and `extract prints suggested allowed_paths and
writes no budget`.

## A file-name keyword match alone is not drift, for out_of_scope only

Drift reads only the changed paths and the caller's `--signals`. The
pre-commit hook runs `check --staged` with no signals
(`packages/core/src/hook.ts:169`), and the GitHub Action builds its `check`
arguments with `--paths` and no signals (`action.yml:671`, `action.yml:719`),
so where the gate blocks, a path is the only evidence there is.

`targetTokens` (`packages/core/src/drift.ts:171`) builds a second token set
without the tokens that come only from a changed file's own name: directory
segments (`packages/core/src/drift.ts:195`), path-category tokens and signal
tokens are in it. For an out_of_scope item, the match is demoted to partial
and not counted only when it has no evidence at all outside the file name: no
token in that second set, no slash path, and no word of the item naming the
file under the closed rule in `namesChangedFile`
(`packages/core/src/tokenize.ts:365`: exactly the basename, the basename
without its final extension, or a `*.ext` word, case-sensitive). Each word of
the item is compared in every form `wordForms`
(`packages/core/src/tokenize.ts:322`) reduces it through: backslashes made
slashes, then leading quotes, backticks, brackets and braces, leading `./`
and `../` prefixes or a lone `/`, a trailing footnote or reference marker,
and trailing punctuation trimmed, and one layer of paired emphasis removed
per step,
repeated until the word stops changing. A markdown link word gives the forms
of its text and of its target, and a `*.ext` glob wrapped in emphasis stars
gives the bare glob. So a name written in markdown, by a relative path or
link, or ending a sentence (`` `Dockerfile`. ``, `**CHANGELOG.md**.`,
`**payment**_methods`, `./Dockerfile`, `[changelog](CHANGELOG.md)`,
`{Dockerfile}`, `*.pem*`) names the file. A dunder name (`__init__.py`) is
never emphasis-stripped, so it names `__init__.py` and never `init.py`. A
slash fragment reads backslashes as slashes and drops trailing sentence
punctuation from each segment (`slashJoinedFragments`,
`packages/core/src/tokenize.ts:234`), so `src\Dockerfile` and
`src/Dockerfile.` are the path `src/Dockerfile`. A home-directory path
(`~/Dockerfile`) names nothing, by ruling: it is outside the repository.
That check is
`packages/core/src/drift.ts:299`; when there is other evidence, the full
strength counts, name tokens included (`packages/core/src/drift.ts:305`).
Constraints are never demoted and keep the 1.9.0 strength
(`packages/core/src/drift.ts:343`).

Matchers are built from `prohibitedSubject`
(`packages/core/src/tokenize.ts:79`), the rule without its leading negation;
`stripEmphasis` (`packages/core/src/tokenize.ts:59`) removes only paired
emphasis markers and backticks, never an underscore inside an identifier:
`EMPHASIS_RE` (`packages/core/src/tokenize.ts:53`) requires a non-alphanumeric
character on both sides of the markers, so `payment_method_ids` stays whole.
From `original_ask`, only sentences with no prohibition marker are
candidates for subtraction (`askScopeSentences`,
`packages/core/src/extract.ts:106`), and an ask
token that an out_of_scope item or a constraint uses is never subtracted
(`packages/core/src/drift.ts:228`).

The second guard alone already implies the first, so the sentence filter in
`askScopeSentences` is defence in depth and has no test of its own. Proof:
every token drift scores a rule on is a token of `prohibitedSubject` of an
out_of_scope item or a constraint (`packages/core/src/drift.ts:276`,
`packages/core/src/drift.ts:331`), and each such token is in `ruleTokens`
(`packages/core/src/drift.ts:224`). An ask token joins the scope set only
when no token of `ruleTokens` matches it (`packages/core/src/drift.ts:228`),
and `tokensMatch` is symmetric (`packages/core/src/tokenize.ts:117`), so no
ask token can match, and subtract, any token a rule is scored on, whether or
not its sentence was filtered. The scope set has no other reader in
drift.ts. The 2026-10-18 audit's mutant M1 (drop the filter) is therefore
equivalent and survives every test by construction (re-run 2026-10-18: all
459 core tests stay green with it applied). A consequence worth
knowing: as drift.ts stands, the ask's sentences subtract nothing from any
rule at all; only in_scope tokens do.

This changes what blocks: an out_of_scope match whose only evidence was a
file-name keyword used to soft-block. Pinned in
`packages/core/tests/extraction-quality.test.ts` by `does not count a match
on the file name only, and says why`, `still counts a match on a directory of
the path`, `still counts a keyword match in the content signals`, `still
counts a rule that names the path itself`, `counts a word that names the
changed file under the closed rule, and a *.ext word` and `does not demote a
constraint: a file name is often a constraint's only evidence`; in
`packages/core/tests/extraction-review-fixes.test.ts` by every case of the
`a rule token equal to a changed file's name is a path match`, `constraints
keep their full strength; the name-only demotion is out_of_scope only`, `an
underscore inside an identifier is part of the identifier` and `a
prohibition in the ask is never subtracted as agreed scope` groups; and in
`packages/core/tests/match-strength.test.ts` by `is strong when Never commit
.env files is touched by apps/web/.env.local`.

The markdown-wrapped and punctuated forms are pinned in
`packages/core/tests/file-name-rule.test.ts` by every case of `names the
file`, `reduces until the word stops changing` and `strips emphasis inside an
identifier`, by `never strips an underscore that is part of an identifier`,
`still names a dunder file whose underscores look like emphasis`, `stays
closed: case-sensitive, no substring, no other extension` and every case of
`counts the match in drift, not as file name only`; and end to end in
`packages/cli/tests/intent-guard.test.ts` by both cases of `extract %j,
freeze, stage %s: check --staged exits 1`. The two-underscore boundary is
pinned by `leaves an identifier with two underscores whole` and `still blocks
a rule naming a two-underscore directory`. Mutations run on 2026-10-18: a
single trim-and-strip pass instead of the loop turns both `reduces until the
word stops changing` cases red; dropping `stripEmphasis` from the reduction
turns 11 cases red, and both end-to-end cases; stripping every underscore
from the word turns the three `strips emphasis inside an identifier` cases
and the `**payment**_methods.` drift case red; dropping the word-boundary
lookarounds from `EMPHASIS_RE` turns `leaves an identifier with two
underscores whole`, `still blocks a rule naming a two-underscore directory`
and the `_payment_methods_` case red.

The second fix round's forms are pinned in the same file by every case of
`blocks` and `stays a pass, as in 1.9.0 or closed by rule` (the 2026-10-18
review's probes, and its negative controls), every case of
`namesChangedFile reads %s as naming %s`, and `keeps a dunder name whole
rather than reading its underscores as emphasis`. Mutations run on
2026-10-18: no leading `./` strip turns `/Dockerfile` and the three `./`
cases of `namesChangedFile reads` red (the `./` drift cases also block
through the slash-fragment path); no link handling turns five link cases
red; no brace trimming turns both `{Dockerfile}` cases red; no starred-glob
form turns both `*.pem*` cases red; keeping trailing punctuation on slash
segments turns `src/Dockerfile.` and `config/.env.local.` red; no dunder
guard turns `pkg/init.py` and the dunder test red; a single pass instead of
the loop still turns both `reduces until the word stops changing` cases red.
Third round (backslash paths, `../`, footnote and reference markers, the
review's cases5): no backslash conversion in `wordForms` turns the `.\` and
`..\` cases of `namesChangedFile reads` red; no backslash conversion in
`slashJoinedFragments` turns `src\Dockerfile` red; no trailing-marker strip
turns the three marker cases of both `blocks` and `namesChangedFile reads`
red; `LEADING_PATH_RE` without `../` turns the `..\` and `../` cases of
`namesChangedFile reads` red.

The pin in this repository's own CI is pinned by `pins the
@vaultcompass/intent-guard devDependency to ci.yml's intent-guard-version`
in `examples/validate-integrations.test.ts`; setting the devDependency back
to 1.2.1 turns it red. The other three gate devDependencies have no test,
because their pins live in the conductor action's defaults; CONTRIBUTING
says each pin change moves them.

## SKILL.md commands run from an installed package

Every intent-guard command in `packages/skill/*/SKILL.md` is `npx --no-install
@vaultcompass/intent-guard <command>`, which exits non-zero naming the package
where it is not installed, and each skill tells the agent that a failed or
empty run did not happen. `packages/skill/tests/skill-docs.test.ts` lints the
four files and runs the documented form in a temp project without the package
(`exits non-zero with a message naming the package in a project that does not
have it`) and with it installed (`runs the published CLI in a project that has
it installed`), on a PATH and npm prefix stripped of any other intent-guard.
On an ordinary machine npx may run an intent-guard already on PATH or in a
global install instead, which can be stale; each skill says to check `--version`
(pinned by `warns that npx may run a stale global copy and says to check the
version`).
