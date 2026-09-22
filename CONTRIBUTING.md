# Contributing to Conductor

**Status:** Design phase -- implementation contributions open after spec approval.

---

## Before you start

Intent Guard is published and in use, so changes land against a working tool
rather than a design under review. Read [docs/cli-reference.md](./docs/cli-reference.md)
for the surface you are changing and [docs/release/stability-policy.md](./docs/release/stability-policy.md)
for what a version number promises, since some of that surface is a contract
and cannot change without a major release. Cross-cutting action and hygiene
claims, each tied to a line, are in [docs/INVARIANTS.md](./docs/INVARIANTS.md).

Open an issue before a large change. A small fix can go straight to a pull
request.

---

## Design feedback

Open a GitHub issue (once remote exists) or comment on the spec with:

- `approve` / `changes: ...`
- Answers to open questions in `04-open-questions.md`

---

## Code standards (when implementation starts)

- TypeScript for `packages/*`
- JSON Schema is source of truth for Intent Contract
- Tests required for schema validation and drift rubric
- No secrets in repo
- Synthetic examples only in `examples/`

---

## Public repo hygiene

Conductor is **public OSS**. Never commit names, paths, or context from other Vault &
Compass products, private monorepos, or internal portfolio work. Two gates enforce
that, and a pull request runs both.

**Do not put in committed files** (including tests, fixtures, changelogs, comments):

- Other product or venture codenames (internal app/repo names)
- Paths like `/Users/.../Projects/<private-app>/` or workspace scan notes
- Dogfood validation tied to a specific private repo
- Session handoffs or maintainer audits

**Use instead:** generic placeholders (`example-app/`, `private downstream app repo`)
and describe the *pattern*, not the source repo.

Local-only notes: `TODO.local.md`, `.local/`.

Before opening a PR, search the diff for private product names and internal paths,
then run both gates:

- `pnpm validate:portfolio-names` is the hash blocklist. No plaintext codenames in
  the repo. To add a hash, see the comment at the top of
  `scripts/validate-no-portfolio-names.mjs`, and add the same digest to
  `scripts/check-public-hygiene.mjs`. A test fails if the two sets diverge.
- `pnpm lint` runs that same blocklist plus two more rules. A non-ASCII em dash or
  en dash fails, including in a file the hash scan allowlists. A machine-specific
  absolute path fails: a home directory, `/var/folders`, or `/private`, with two
  segments under that root. `pnpm lint` prints the offending file and line and
  points back at this section.

**Git history:** Older commits may still mention product names. Cleaning **current**
files is required; rewriting **history** needs `git filter-repo` and a force-pushed
`main` (coordinate with maintainers -- usually not worth it once HEAD is clean).

---

## Superpowers upstream

Skills may be contributed to [obra/superpowers](https://github.com/obra/superpowers) after v0.3 beta. Coordinate via issue before duplicating skill names.

---

## Findings log

[FINDINGS.md](./FINDINGS.md) is a durable, append-by-PR record of what
intent-guard actually did when run against real changes, including runs
that caught nothing. Open a PR to append a row after you run it against
real code, your own or someone else's.

---

## License

By contributing, you agree your contributions are licensed under MIT.
