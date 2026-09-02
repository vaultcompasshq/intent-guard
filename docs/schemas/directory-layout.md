# `.conductor/` directory layout

**Version:** 1.0.0  
**Phase:** 2

Per-project Intent Guard state lives at the repository root of the app being governed (not necessarily the Intent Guard OSS repo). The directory is still named `.conductor/`: it was not renamed in 1.2.0, so existing projects keep working untouched.

## Layout

```
.conductor/
├── config.yaml              # Drift thresholds, coach settings, integration hooks
├── intent-contract.yaml     # Active frozen intent (or draft before approval)
├── index.md                 # MEMORY.md-style pointer file (Phase 3 expands this)
├── contracts/               # Historical contract snapshots
│   └── ic-YYYYMMDD-xxxxxx.yaml
└── drift-log.jsonl          # Append-only drift events (optional gitignore)
```

## Files

| File | Required | Committed? | Purpose |
|------|----------|------------|---------|
| `config.yaml` | Recommended | Yes | Thresholds and integration settings |
| `intent-contract.yaml` | For gated sessions | Yes (team visibility) | Frozen intent artifact |
| `index.md` | Optional | Yes | Human-readable session index |
| `contracts/` | Optional | Yes | Archived superseded contracts |
| `drift-log.jsonl` | Optional | Often gitignored | Session drift audit trail |

## Init

```bash
pnpm intent-guard:init
# or: node packages/skill/dist/init-cli.js --project /path/to/project
```

Creates `config.yaml`, `index.md`, and `contracts/` if missing.

## Example config

See [examples/intent-guard.config.example.yaml](../../examples/intent-guard.config.example.yaml).

## Contract schema

Validated against `packages/schema/src/intent-contract.schema.json`.

Examples: [examples/intent-contracts/](../../examples/intent-contracts/).
