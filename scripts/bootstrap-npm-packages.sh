#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES=(
  "packages/schema"
  "packages/core"
  "packages/skill"
  "packages/cli"
)

echo "Bootstrap first publish for @vaultcompass/intent-guard*"
echo "Requires: npm login with publish access to @vaultcompass"
echo ""

if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: npm login"
  exit 1
fi

echo "Logged in as: $(npm whoami)"
cd "$ROOT"
pnpm build
pnpm release:smoke

for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "Publishing ${pkg}..."
  (cd "$ROOT/$pkg" && pnpm publish --access public --tag latest)
done

cat <<'EOF'

Next on npmjs.com (each package, then Settings, then Trusted Publisher):
  Publisher: GitHub Actions
  Organization or user: vaultcompasshq
  Repository: intent-guard
  Workflow filename: release.yml
  Environment name: leave blank (release.yml declares no environment)

Then tag the release from main and push the tag. The release workflow
skips any package whose exact version is already on the registry, so a
tag matching the version just published goes green, creates the GitHub
Release, and smoke-tests the published CLI without republishing:
  git tag vX.Y.Z && git push origin vX.Y.Z
EOF
