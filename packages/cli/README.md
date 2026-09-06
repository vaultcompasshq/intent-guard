# @vaultcompass/intent-guard

Unified CLI for [Intent Guard](https://github.com/vaultcompasshq/intent-guard) — intent contracts, drift checks, session continuity, and setup diagnostics.

> Renamed in 1.2.0. This package was published as `@vaultcompass/conductor-cli`
> through 1.1.0, and the binary was `conductor`. The binary is now
> `intent-guard`, and the per-command binaries are `intent-guard-check`,
> `intent-guard-report`, and so on. Re-run `intent-guard hook install` to
> refresh a pre-commit hook that still calls the old binary name.

> Renamed again in 1.3.0: per-project state lives in `.intent-guard/`, not
> `.conductor/`, which is now the name of a different product in this family.
> An existing `.conductor/` is read as-is with a notice and renamed on the
> first write. If both directories exist, commands fail closed rather than
> guessing.

## Install

```bash
npm install -D @vaultcompass/intent-guard
# or one-off:
npx @vaultcompass/intent-guard@latest init --project .
```

## Quickstart

```bash
intent-guard init --project .
intent-guard extract --project . --text "Add CSV export. Do not add new API endpoints."
intent-guard freeze --project . --approved-by "<you>"
intent-guard check --project . --staged
intent-guard doctor --project .
intent-guard report --project . --staged
```

Every command takes `--help`, which prints usage and exits 0 without running anything.

Pair with [@vaultcompass/vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) for secret scanning in pre-commit or CI.

## Docs

- [CLI reference](https://github.com/vaultcompasshq/intent-guard/blob/main/docs/cli-reference.md)
- [Integrations](https://github.com/vaultcompasshq/intent-guard/tree/main/integrations)
- [Stability policy](https://github.com/vaultcompasshq/intent-guard/blob/main/docs/release/stability-policy.md)

## License

MIT
