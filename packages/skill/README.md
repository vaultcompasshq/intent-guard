# @vaultcompass/intent-guard-skill

Superpowers-compatible skills and the per-command `intent-guard-*` CLIs for [Intent Guard](https://github.com/vaultcompasshq/intent-guard).

> Renamed in 1.2.0. This package was published as
> `@vaultcompass/conductor-skill` through 1.1.0, and its binaries were named
> `conductor-*`. They are now `intent-guard-*`: `intent-guard-check`,
> `intent-guard-report`, `intent-guard-resume`, and so on. A pre-commit hook or
> agent hook that calls an old binary name needs updating, or re-run
> `intent-guard hook install`.

## Install

```bash
npm install -D @vaultcompass/intent-guard-skill
```

Prefer the unified binary: `@vaultcompass/intent-guard` (`intent-guard <subcommand>`).

## Skills

Shipped under this package:

- `intent-contract`
- `prompt-coach`
- `drift-guard`
- `capture-correction`

Copy into your agent skills directory or follow [integrations/superpowers](https://github.com/vaultcompasshq/intent-guard/tree/main/integrations/superpowers).

## License

MIT
