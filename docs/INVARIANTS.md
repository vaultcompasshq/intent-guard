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

The default is `1.8.0` at `action.yml:41`.

## On a pull request, `version` may not pin older than this tag's scanner

`IG_TAG_SCANNER_MAJOR`, `IG_TAG_SCANNER_MINOR` and `IG_TAG_SCANNER_PATCH`
are `1`, `8` and `0` at `action.yml:257` through `action.yml:259`.
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

README states the same floor at `README.md:281` and the same Node bound at
`README.md:284` through `README.md:285`. The drift check also pins the
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

They are not right now: `README.md:265` pins `vaultcompasshq/intent-guard@v1.8.0`,
and `README.md:272` says that tag installs `@vaultcompass/intent-guard@1.8.0`,
because this release moved the action tag and the packages together. They
diverged briefly at 1.5.3, an action-only tag documented at
`CHANGELOG.md:237` that moved the workflow file without publishing new
packages; `CHANGELOG.md:264` still records that history, naming
`IG_TAG_SCANNER` as 1.5.2 on the 1.5.3 tag. The installed
version is the `version` input default at `action.yml:41`, the scanner
constant at `action.yml:257` through `action.yml:260`, and the package
version `1.8.0` in `package.json:4`, `packages/cli/package.json:3`,
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

`packages/skill/src/changed-paths.ts:30` splits on NUL, and both git calls pass
`-z` (`packages/skill/src/changed-paths.ts:98` for `--staged`,
`packages/skill/src/changed-paths.ts:183` for `--base`). Without `-z`, git
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
`packages/skill/src/changed-paths.ts:55` raises `maxBuffer` to 256 MB (the 1 MB
default threw ENOBUFS, which used to pass), and `stagedPaths` returns empty only
when `git rev-parse --git-dir` says "not a git repository"
(`changed-paths.ts:70` through `:80`); every other failure exits 2
(`changed-paths.ts:112`). Pinned by `still blocks when the staged name list is
larger than 1 MB` (a real 1.3 MB list, not an injected size), `passes quietly
outside a git repository, as before` and `exits 2 on any other git failure`.

`--staged` and `--base` list a moved submodule pointer whatever `ignore`
setting the repository carries for it: both diffs pass
`--ignore-submodules=none` (`changed-paths.ts:96` and `changed-paths.ts:181`),
which overrides `.gitmodules` and git config alike. Pinned by the `a moved
submodule pointer is always listed` tests in
`packages/skill/tests/base-ref.test.ts`: `--base, when the branch sets ignore =
all and moves the pointer`, `--base, when the base already has ignore = all and
the branch only moves the pointer`, `--staged, with ignore = all in
.gitmodules` and `--staged, with diff.ignoreSubmodules = all in the repository
config`.

`--base` ends its revisions with `--` (`changed-paths.ts:187`), so a file named
like the range is not read as one. Pinned by `judges a branch that adds a file
named like the range it is diffed with`. `basePaths` refuses a ref that starts
with a dash itself, exit 2 (`changed-paths.ts:167` through `:171`), because git
reads `-Sxyz...HEAD` as an option and lists nothing. Pinned by `refuses a --base
value that starts with a dash (-Sxyz) as could-not-run` and its `-Gnomatch`,
`-O/dev/null`, `-p` and `-R` twins, by `refuses a dash-leading ref inside
basePaths itself, not only in the caller`, and for report by `refuses a --base
value that starts with a dash as could-not-run`, all in
`packages/skill/tests/base-ref.test.ts`.

## A trust-base read is never redirected by a dash or a file name

Every git call in `packages/core/src/trust-base.ts` that takes a ref refuses
one that starts with a dash before git sees it (`refuseDashRef` at
`trust-base.ts:100`, called at `trust-base.ts:119` for rev-parse,
`trust-base.ts:242` for show and `trust-base.ts:298` for ls-tree), with a
`TrustBaseError`, which every CLI turns into exit 2. Pinned by the `trust-base
git calls refuse a dash-leading ref` tests in
`packages/core/tests/trust-base-refs.test.ts` and by `refuses a --trust-base
value that starts with a dash, by name` in
`packages/skill/tests/trust-base.test.ts`.

`git show` ends its revision with `--` (`trust-base.ts:244`), so a file in the
tree named like `main:./.intent-guard/config.yaml` does not make the read fail.
A control file or archived contract that `ls-tree` lists but `git show` cannot
read is a `TrustBaseError` (`readListedBlob` at `trust-base.ts:356`, used at
`trust-base.ts:342` and `trust-base.ts:649`), never empty text and never "no
such file". So is an `ls-tree` that exits non-zero (`trust-base.ts:306`
through `:310`); only a listing that succeeds and names nothing means the base
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
(`conductor-stop-check.sh:187` through `:189`) whatever the gate said, and
with no gate binary too (`conductor-stop-check.sh:169` and `:170`). Pinned in
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
too, so such a path is could-not-run instead: after the gate has judged and
passed everything else, `unpassable_verdict` (`conductor-stop-check.sh:154`,
reached at `:202`) calls `could_not_run`, and the message says which paths
were not judged and that a new session after the first commit restores full
judging. A finding from the gate on this route still blocks every time
(`conductor-stop-check.sh:192` through `:194`, before `:202`). Pinned in the
`stop hook with an empty-tree baseline` group by `still blocks a finding every
time when a comma file is committed beside it`, `blocks once on a committed
comma file, then lets the active stop through loudly` and `blocks once on a
list too long to pass, then lets the active stop through loudly`.

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
`conductor-stop-check.sh:192`: status 1 is a finding and always blocks
(`lifecycle_block`, exit 2), regardless of `stop_hook_active`; any other
non-zero status is could-not-run (`conductor-stop-check.sh:197`). Every
could-not-run condition (gate exit 2 or 127, no binary at `:172`, path
collection failure at `:97`, an unpassable path on the empty-tree route at
`:159`, an unusable baseline at `:205`) calls `could_not_run` (`:60`): with
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

`packages/skill/src/changed-paths.ts:216` calls `explicitPathIssue`
(`changed-paths.ts:125`) on every `--paths` entry and exits 2 (`changed-paths.ts:221`)
for a `..` segment, a `.` segment anywhere other than the one accepted leading
`./`, an empty segment (`a//b`, `.//x`), a leading `/`, or a backslash. They are
refused, not normalized, because `src/../secrets/k` never matched `secrets/**`
while naming a protected file. intent-guard's own git reads (`--staged`,
`--base`) are not subject to this. A caller that forwards paths through `--paths`
must read git with `-z` and never forward git's C-quoted form, which would
otherwise reach the budget quoted and match no glob. Pinned in
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
