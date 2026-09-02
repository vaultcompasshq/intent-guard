# @vaultcompass/intent-guard-core

Core libraries for [Intent Guard](https://github.com/vaultcompasshq/intent-guard): prompt coaching, drift scoring, enforcement gate, corrections, session brief, memory index, and setup diagnostics.

> Renamed in 1.2.0. This package was published as `@vaultcompass/conductor-core`
> through 1.1.0. Update the import specifier; the exported API is unchanged.

## Install

```bash
npm install @vaultcompass/intent-guard-core
```

Typically consumed via `@vaultcompass/intent-guard` or `@vaultcompass/intent-guard-skill`. Use this package when embedding Intent Guard in Node tooling.

## Exports

Coaching, drift, gate, contract store, init, doctor, report, rules audit, spec bridge, history, and correction utilities. See `dist/index.d.ts` after install.

Findings carry a deterministic `fingerprint`. The recipe is documented in
[the CLI reference](https://github.com/vaultcompasshq/intent-guard/blob/main/docs/cli-reference.md).

## License

MIT
