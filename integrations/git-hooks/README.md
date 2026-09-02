# Git Hook Integration

Use these samples when a repository wants a local pre-commit gate.

## Intent Guard Only

```bash
cp integrations/git-hooks/pre-commit.sample .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The hook runs:

```bash
intent-guard-check --project . --staged
```

It exits non-zero when no frozen Intent Contract exists or staged changes drift
past a blocking threshold.

## Intent Guard Plus vault-guard

```bash
cp integrations/git-hooks/pre-commit-with-vault-guard.sample .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The paired hook runs:

```bash
intent-guard-check --project . --staged
vault-guard scan --staged
```

The checks are independent. Intent Guard blocks intent drift; vault-guard blocks
staged secrets. Set `INTENT_GUARD_CHECK` or `VAULT_GUARD` if either binary is not
on `PATH`. `CONDUCTOR_CHECK` is still read as a fallback, since this tool was
called conductor through 1.1.0.

Both gates run even when the first one fails, so one commit attempt shows every
problem, and each gate's exit code is printed. The script exits with the first
non-zero code it saw: a later gate must not overwrite an earlier gate's code,
because exit 2 ("could not complete, treat as blocking") and exit 1 ("policy
violation") are different answers.

These samples skip a gate whose binary is missing, so a team can adopt the two
gates one at a time. `intent-guard hook install` generates a fail-closed hook
instead: a missing gate binary exits 127 and the commit is refused. Once both
tools are genuinely installed, prefer the generated hook.
