# GitHub Actions Integration

Use these samples when a repository already has a frozen
`.conductor/intent-contract.yaml` and wants CI to fail on blocking drift.

The package-install samples assume `@vaultcompass/conductor-cli@latest`
has been published to npm. Until publish, run Conductor from a local checkout or
a release artifact in the consuming repository's workflow.

For Conductor only, copy
[conductor-drift-ci.yml.sample](./conductor-drift-ci.yml.sample) to:

```text
.github/workflows/conductor-drift.yml
```

Then adjust the `--paths` collection if your workflow needs a different diff
range. The sample uses changed files from the pull request base and passes them
to:

```bash
conductor check --project . --paths "$CHANGED_PATHS"
```

`conductor check` is the full gate: it scores drift and enforces the contract's
change budget (allowed/protected paths, max files, dependency guard), so CI
blocks the same work the pre-commit hook does. It exits `1` when the gate
blocks. Add `--no-require-frozen` if a branch may not carry a frozen contract.

Note: `conductor drift --ci` is a lower-level, score-only command. It does not
enforce the change budget, so prefer `check` in CI to keep local and CI
enforcement identical.

For Conductor plus vault-guard, copy
[conductor-vault-guard-ci.yml.sample](./conductor-vault-guard-ci.yml.sample) to:

```text
.github/workflows/conductor-vault-guard.yml
```

That workflow runs the same gate check, then runs:

```bash
npx --yes @vaultcompass/vault-guard@latest -- scan . --format text
```

The two checks are independent. Conductor blocks intent drift; vault-guard
blocks leaked secrets.
