# Conductor Agent Playbook

**Repo:** `github.com/vaultcompasshq/conductor` (public OSS, MIT)

Conductor is the intent-fidelity layer for AI-assisted development: Intent Contract schema, prompt coaching, drift scoring, correction capture, and session resume. It is a governance layer for coding assistants, not a replacement for planning, review, or CI.

---

## Read Order

| # | File | Purpose |
|---|------|---------|
| 1 | [docs/cli-reference.md](./docs/cli-reference.md) | Every CLI command and flag |
| 2 | [README.md](./README.md) | Product overview, package layout, dev commands |
| 3 | [docs/schemas/directory-layout.md](./docs/schemas/directory-layout.md) | What the tool writes, and where |
| 4 | [docs/release/stability-policy.md](./docs/release/stability-policy.md) | What a version number promises |

Maintainer records (status, backlog, roadmap, design specs, validation runs)
are deliberately not in this repository. The public content policy has always
said they must not be committed, and they now live where it says they should:
outside the public tree. If you are working here and need them, ask for the
maintainer notes rather than reconstructing them from git history.

---

## Phase Status

| Phase | Weeks | Status |
|-------|-------|--------|
| 1 - Schema + core | 1-2 | Complete |
| 2 - Runtime + skills | 3-6 | Complete (`packages/skill`, CLIs, config, init) |
| 3a - Correction log + brief | - | Complete (PR #4) |
| Hardening - generic scorer, gate, approval | - | Complete (PRs #1, #3, #5) |
| 3 - Memory-index persistence | 7-10 | Core complete (`history`, generated index, resume, pivot, cross-session drift) |
| 3b - decay/dedup, LLM normalization | - | Deferred |
| 4 - Unified CLI + public release | 11-14 | **Complete** — `1.0.0` on npm ([release](https://github.com/vaultcompasshq/conductor/releases/tag/v1.0.0)) |
| 1.1.0 - Change Budget | - | Done — on npm ([release](https://github.com/vaultcompasshq/conductor/releases/tag/v1.1.0)) |

---

## Packages

```
packages/
├── schema/     # @vaultcompass/conductor-schema - AJV validator + types
├── core/       # @vaultcompass/conductor-core - coach, drift, gate, correction, brief, history
├── skill/      # @vaultcompass/conductor-skill - skills + legacy CLIs
├── cli/        # @vaultcompass/conductor-cli - unified conductor binary
└── memory/     # deferred; file-backed memory currently lives in core
```

CLIs are documented in [docs/cli-reference.md](./docs/cli-reference.md).
Lifecycle: coach -> extract (draft) -> freeze (approve) -> check (gate) -> pivot/correct -> brief/resume.

---

## Current Work

1.2.1 is on npm. It added `check --base <ref>`, so a pull request can be gated
against its merge base rather than the index, and an importer for the spec and
plan markdown this organisation writes.

Skills in the tree: `intent-contract`, `prompt-coach`, `drift-guard`,
`capture-correction`.

PRs only onto `main`. CI green before merge. Write a plan before multi-step work.

---

## Verification

```bash
pnpm install
pnpm test      # 180 tests: schema (11), core (114), skill (32), cli (11), examples/integrations (12)
pnpm dogfood:cursor-hooks
pnpm dogfood:claude-hooks
pnpm build
pnpm typecheck
pnpm release:smoke
pnpm validate:portfolio-names
pnpm validate:public-repos   # manual; clones public GitHub repos
```

`pnpm test` builds first because the skill CLI tests spawn compiled `dist/` files.

Paste actual test output before claiming tests pass.

---

## Boundaries

- Keep this repo focused on Conductor packages, docs, examples, and integration samples.
- Do not commit local per-project `.conductor/intent-contract.yaml` files here; consuming application repos own their active contracts.
- Keep examples synthetic. Do not commit customer data, private project specs, API keys, or internal portfolio data.
- **Never name portfolio products or link to private V&C app repos** in tracked files. Use generic "private downstream app repo" / "downstream integration" wording. Enforce with `pnpm validate:portfolio-names`; policy: [docs/release/public-content-policy.md](./docs/release/public-content-policy.md). Maintainer notes belong in gitignored `.local/` or `TODO.local.md` only.
- Runtime wiring for downstream products belongs in those downstream repos. This repo should expose packages and documented integration surfaces.

---

## License

MIT - see [LICENSE](./LICENSE)
