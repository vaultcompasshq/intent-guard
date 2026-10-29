# GitHub Actions Integration

## Use the action

The recommended shape is the published composite action, not a hand-written
workflow:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- uses: vaultcompasshq/intent-guard@v1.10.3
```

There is no `version` input in that example because the default is the version
the action shipped with, so the tag you pin the action to is the version that
judges the pull request.

It decides both refs from the event: `--base origin/$GITHUB_BASE_REF` for the
paths it judges, and `--trust-base` for where the contract, the config and the
contracts archive are read from. A workflow that forgets `--trust-base` reads
the rules out of the branch it is judging, so a pull request can widen its own
contract in the commit being judged and the gate agrees. The action cannot
forget. See the [README](../../README.md#github-action) for every input, and
note that there is no SARIF: the verdict is in the job log, and the job's own
pass or fail is what branch protection reads.

## The samples, for a workflow you write yourself

Use these when the action does not fit: a self-hosted runner without registry
access, a job that has to do something between the steps, or a repository that
pins its own copy of the workflow. They are the manual alternative, not the
starting point. Both pass `--base "origin/$BASE_REF"` and
`--trust-base "origin/$BASE_REF"`, the same pair the action builds, and both
pin an exact released version rather than `@latest`. Keep both flags in any
copy that runs on a pull request. When `check` is given `--base` without
`--trust-base` and the change edits the contract, `config.yaml` or the
contracts archive, it prints a warning naming the file and the missing flag;
the exit code does not change.

Like the action, they install the pinned version with `npm install -g
--ignore-scripts` into a prefix under the runner temp, from the runner temp
rather than the checkout, and call it there by absolute path. So the tree being
judged cannot repoint the registry with a committed `.npmrc` or hand over its
own copy out of `node_modules`. Never fetch a gate with `npx` or `pnpm dlx` from
inside the checkout. What the samples leave out is the action's npm version
floor and its `npm audit signatures` step; see [action.yml](../../action.yml).

Use these samples when a repository already has a frozen
`.intent-guard/intent-contract.yaml` and wants CI to fail on blocking drift.

For Intent Guard only, copy
[conductor-drift-ci.yml.sample](./conductor-drift-ci.yml.sample) to:

```text
.github/workflows/conductor-drift.yml
```

The sample lets the gate list the pull request's changes itself, from the
merge base with the base branch, and reads the rules from that same base:

```bash
"$RUNNER_TEMP/ig/bin/intent-guard" check --project . --base "origin/$BASE_REF" --trust-base "origin/$BASE_REF"
```

`intent-guard check` is the full gate: it scores drift and enforces the contract's
change budget (allowed/protected paths, max files, dependency guard), so CI
blocks the same work the pre-commit hook does. It exits `1` when the gate
blocks. Add `--no-require-frozen` if a branch may not carry a frozen contract.

Note: `intent-guard drift --ci` is a lower-level, score-only command. It does not
enforce the change budget, so prefer `check` in CI to keep local and CI
enforcement identical.

For Intent Guard plus vault-guard, copy
[conductor-vault-guard-ci.yml.sample](./conductor-vault-guard-ci.yml.sample) to:

```text
.github/workflows/conductor-vault-guard.yml
```

That workflow installs `@vaultcompass/vault-guard@1.12.1` the same way, runs
the same gate check, then runs:

```bash
"$RUNNER_TEMP/vg/bin/vault-guard" scan . --format text --trust-base "origin/$BASE_REF"
```

`--trust-base` reads `.vault-guard.json` from the base branch, so a pull request
cannot add an allowlist entry that silences its own finding.

The two checks are independent. Intent Guard blocks intent drift; vault-guard
blocks leaked secrets.
