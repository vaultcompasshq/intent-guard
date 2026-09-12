# Security policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.5.x   | :white_check_mark: |
| < 1.5   | :x:                |

The latest published minor is supported; earlier minors are not patched.
See [docs/release/stability-policy.md](./docs/release/stability-policy.md)
for what a version number promises.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Send details to **security@vaultcompass.io** (or the contact listed on
[vaultcompass.io](https://vaultcompass.io) if that address changes). Include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions / components (`@vaultcompass/intent-guard` CLI,
  `@vaultcompass/intent-guard-core`, `@vaultcompass/intent-guard-skill`,
  `@vaultcompass/intent-guard-schema`, the composite GitHub Action, the
  pre-commit hook, the editor hooks)

We aim to acknowledge receipt within **5 business days** and coordinate a
fix and disclosure timeline with you.

## Scope

In scope: a change that should be blocked by a frozen contract or a change
budget and is not; any way a pull request can change the contract, the
config, or the rules it is judged by on a pull-request run (the trust base);
shell or argument injection through the Action's inputs; the Action
resolving the gate from inside the tree it judges; supply-chain issues in
the published packages.

Out of scope: drift the gate cannot see by design, because it reads the
paths a change touched and never the diff (documented in the README); a
prompt or signal supplied by the caller that misdescribes the change;
third-party dependencies (report to the upstream maintainer; we still
welcome coordinated notification).

## npm provenance

Published `@vaultcompass/*` packages are built from this repository's tagged
releases through the OIDC trusted-publisher path, with npm provenance
attestations, and never from a developer machine.
