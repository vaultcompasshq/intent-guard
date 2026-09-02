#!/usr/bin/env bash
# Dogfood Intent Guard on a consuming application repo.
# Usage: ./scripts/dogfood-app.sh /path/to/app-repo [intent-guard-version]
set -euo pipefail

TARGET="${1:-}"
VERSION="${2:-latest}"
VG_BIN="${VAULT_GUARD_BIN:-}"

if [[ -z "$TARGET" || ! -d "$TARGET" ]]; then
  echo "Usage: $0 /path/to/app-repo [npm-version]"
  echo "  VERSION defaults to 'latest' (@vaultcompass/intent-guard@latest)"
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== Intent Guard dogfood ==="
echo "Target repo: $TARGET"
echo "CLI version: $VERSION"
echo ""

cd "$WORK"
npm init -y >/dev/null 2>&1
npm install "@vaultcompass/intent-guard@${VERSION}"
INTENT_GUARD="$WORK/node_modules/.bin/intent-guard"

"$INTENT_GUARD" --version
echo ""

echo "--- init ---"
"$INTENT_GUARD" init --project "$TARGET" --human
test -f "$TARGET/.conductor/config.yaml"

echo ""
echo "--- extract (dry run) ---"
"$INTENT_GUARD" extract --project "$TARGET" --dry-run --text \
  "Dogfood smoke: document one-line scope only. Do not modify source files."

echo ""
echo "Next steps (manual, in $TARGET):"
echo "  1. intent-guard extract --project . --text \"<real task for this app>\""
echo "  2. intent-guard freeze --project . --approved-by <you>"
echo "  3. Make a small aligned change, then: intent-guard check --project . --staged"
echo "  4. Make an out-of-scope change, confirm check blocks or warns"
echo "  5. Optional: intent-guard hook install --project . --with-vault-guard"
echo ""
echo "See docs/release/v1-launch-checklist.md — mark dogfood items when done."

if [[ -n "$VG_BIN" && -x "$VG_BIN" ]]; then
  echo ""
  echo "vault-guard found at $VG_BIN; run the paired hook sample from the integrations directory."
fi

echo ""
echo "Dogfood bootstrap: OK"
