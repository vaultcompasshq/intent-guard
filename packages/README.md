# Packages

| Package | NPM name | Status | Description |
|---------|----------|--------|-------------|
| `schema/` | `@vaultcompass/intent-guard-schema` | Stable | Intent Contract JSON Schema v1.0.0, TypeScript types, and Ajv validation (`validateIntentContract`, `assertValidIntentContract`) |
| `core/` | `@vaultcompass/intent-guard-core` | Stable | Prompt coach, extraction, drift scoring, gate, correction log, brief, history, and memory index |
| `memory/` | - | Deferred | Separate package deferred; file-backed memory currently lives in `core/` |
| `cli/` | `@vaultcompass/intent-guard` | Unified CLI | `intent-guard <subcommand>` binary |
| `skill/` | `@vaultcompass/intent-guard-skill` | Stable | Superpowers skills and the per-command CLIs |

All four were published under `@vaultcompass/conductor-*` through 1.1.0 and
renamed in 1.2.0. The directory names here are generic (`cli/`, `core/`) and did
not change.

See [implementation roadmap](../docs/phases/implementation-roadmap.md) for the full 14-week plan.
