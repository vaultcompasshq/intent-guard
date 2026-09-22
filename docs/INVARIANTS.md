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

The drift check counts the shape three times in total and the executable
form `[[ ! "${IG_VERSION}" =~ <shape> ]]` twice
(`scripts/tests/action-hardening-drift.test.mjs`). The description is the
third copy. Removing one executable match drops both counts.

The default is `1.5.2` at `action.yml:41`.

## On a pull request, `version` may not pin older than this tag's scanner

`IG_TAG_SCANNER_MAJOR`, `IG_TAG_SCANNER_MINOR` and `IG_TAG_SCANNER_PATCH`
are `1`, `5` and `2` at `action.yml:257` through `action.yml:259`.
`IG_TAG_SCANNER` is assembled from those three at `action.yml:260`. The
comparison that refuses an older pin is `action.yml:300` through
`action.yml:307`, and the error that names both versions is
`action.yml:311`. The comparison runs only when `GITHUB_BASE_REF` is
non-empty (`action.yml:270`).

## npm older than 10.5.2 is refused before install

The floor is accept-only. `action.yml:538` accepts a major above 10.
`action.yml:540` accepts major 10, then `action.yml:541` accepts a minor
above 5, and `action.yml:543` accepts minor 5 with patch at least 2. Anything
else leaves `NPM_OK` at 0. The refusal text is `action.yml:549`: `npm 10.5.2
or newer`. The remediation is `action.yml:550`: Node 20.13.0 and later, and
22.1.0 and later, are fine; 22.0.0 ships npm 10.5.1.

README states the same floor at `README.md:265` and the same Node bound at
`README.md:268` through `README.md:269`.

The drift check pins the five comparison fragments and the `npm 10.5.2 or
newer` sentence. The comment at `action.yml:490` says `OR NEWER` in
capitals, so it is not that sentence.

## The scanner is installed with `--ignore-scripts`

The install line is `action.yml:560`:

`npm install -g --ignore-scripts "@vaultcompass/intent-guard@${IG_VERSION}"`

The comment at `action.yml:554` names the flag. It is not that command. The
drift check pins the command.

## `npm audit signatures` runs in a subshell on the synthetic manifest

The invocation is `action.yml:602`:

`( cd "${npm_config_prefix}/lib" && npm audit signatures )`

`action.yml:493` and `action.yml:565` also contain the words `npm audit
signatures`. They are comments. The drift check pins the subshell, so those
comments do not keep it green. The synthetic manifest the command depends on
is written at `action.yml:575`.

## The action tag and the installed package are different numbers

`README.md:251` pins `vaultcompasshq/intent-guard@v1.5.3`.
`README.md:256` says that tag installs `@vaultcompass/intent-guard@1.5.2`.
The installed version is the `version` input default at `action.yml:41`,
the scanner constant at `action.yml:257` through `action.yml:260`, and the
package version `1.5.2` in `package.json:4`, `packages/cli/package.json:3`,
`packages/core/package.json:3`, `packages/schema/package.json:3` and
`packages/skill/package.json:3`. `CHANGELOG.md:32` is the 1.5.3 action
release. `CHANGELOG.md:59` still records the scanner constant as 1.5.2.

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
`scripts/tests/coauthor-trailer.test.mjs` reads that pattern back out of
the workflow and matches a planted `Co-authored-by: Cursor <cursoragent@cursor.com>`
line. A message with no trailer does not match.
