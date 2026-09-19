# FINDINGS

This is a durable, append-by-PR record of what intent-guard actually did
when run against real changes: this repo's own drift checks, other Vault &
Compass repos, or artifacts from public downstream projects. A gate result
that only lives in a terminal scroll or a closed pull request evaporates;
this file is the place it lands instead, so false-positive and
false-negative classes accumulate across runs instead of being rediscovered
by the next person who hits them.

A run that found nothing still gets a row. "It caught nothing" is itself a
datum: it is the only way to tell whether the gate is blind on that input or
the base rate of real drift in it is genuinely low. Log the clean run, not
just the interesting one.

## Format

One row per run. Append new rows at the bottom, in chronological order. Do
not edit or delete existing rows; if a verdict turns out to be wrong on
later review, append a new row that corrects it and say which row it
corrects.

Verdict is one of: true positive, false positive, true negative, false
negative, could-not-run.

| Date | What was scanned (repo/artifact + version) | What the gate said | Verdict | Follow-up |
|---|---|---|---|---|
| 2026-01-01 (EXAMPLE) | example-app (git SHA abc1234) + intent-guard 1.5.2, intent-guard check --paths src/billing/invoice.ts | 1 finding: drift, path outside contract scope | true positive | none |
| 2026-09-18 | A pull request whose change set was an empty diff, run through intent-guard 1.5.1's check, report and drift CLIs with --paths "" and --signals "" (the umbrella's way of stating an explicitly empty change set) | error: option '--paths' requires a value, plus the full usage screen, exit 1, no report written | could-not-run | Fixed in 1.5.2: an empty string after a list flag is now read as a value meaning zero entries, not a missing value. See CHANGELOG.md, [1.5.2] - 2026-09-18. |

## How to add an entry

Open a pull request that appends one row to the table above. Any seat may
open it, human or agent. Keep the table chronological. A clean run (true
negative) and a run the gate could not complete (could-not-run) are both
worth recording, not just the runs that found something.
