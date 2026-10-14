---
name: prompt-coach
description: >-
  Coach vague or scope-exploding user prompts before execution. Use when the
  user message scores low on prompt quality, uses minimizers (just/quickly),
  stacks product comparisons, or lacks testable acceptance criteria. Never
  blocks -- only suggests rewrites.
---

# Prompt Coach

**Announce at start:** "I'm using the prompt-coach skill to improve prompt clarity."

## When to run

- Inside `intent-contract` when prompt quality score &lt; 60
- Standalone when the user message is vague or scope-expanding
- When patterns detected: `product_stack`, `scope_adverb`, `implicit_pivot`, `missing_acceptance_criteria`

## Never blocks

Show coaching and suggested rewrite. User may proceed without changing their ask.

## Score prompt (helper CLI)

Run from the target project's root, with `@vaultcompass/intent-guard`
installed there (`npm install -D @vaultcompass/intent-guard`). `npx
--no-install` can run an intent-guard it finds on PATH or in a global install
instead of the project's copy, so check `npx --no-install
@vaultcompass/intent-guard --version` against the project's package.json
first:

```bash
npx --no-install @vaultcompass/intent-guard coach "USER MESSAGE HERE"
```

If the command exits non-zero, prints "npx canceled due to missing
packages" or "command not found", or prints no JSON, the prompt was NOT
scored: the coach did NOT run. Say so instead of reporting a score.

JSON output:

- `score` -- 0-100 (show coaching when &lt; 60)
- `issues` -- pattern IDs from coach library
- `coaching` -- formatted message with suggested rewrite
- `needs_coaching` -- boolean shortcut

## Response template

When coaching is needed, show:

1. **Prompt variance warning** -- list detected patterns and why they cause drift
2. **Suggested rewrite** -- narrower, testable version
3. One follow-up question if acceptance criteria are still missing

Example follow-up: "What should 'done' look like -- one testable outcome?"

## Patterns (reference)

| Pattern | Signal |
|---------|--------|
| `product_stack` | Multiple product names as comparators |
| `comparative_overload` | More than two "like X" phrases |
| `scope_adverb` | "just", "quickly", "simply" + large ask |
| `implicit_pivot` | "actually", "also", "while we're at it" |
| `constraint_conflict` | Ask contradicts loaded AGENTS.md / CLAUDE.md |
| `vague_ask` | Under 20 characters |
| `missing_acceptance_criteria` | No testable done criteria |

Implementation: `packages/core/src/coach-patterns.ts`

## After coaching

If part of `intent-contract`, update the draft contract fields before freezing.
