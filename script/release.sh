#!/usr/bin/env bash
set -euo pipefail

# Release script for 0x0 monorepo.
# Bumps version, tags, and pushes — CI handles the rest.
#
# Usage:
#   ./script/release.sh <patch|minor|major>
#   ./script/release.sh 7.1.0          # explicit version

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Resolve version ---

CURRENT_VERSION=$(cd apps/server && node -p "require('./package.json').version")

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <patch|minor|major|X.Y.Z>"
  echo "Current version: $CURRENT_VERSION"
  exit 1
fi

BUMP="$1"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  case "$BUMP" in
    patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    *) echo "Invalid bump type: $BUMP"; exit 1 ;;
  esac
fi

echo "Releasing: $CURRENT_VERSION → $NEW_VERSION"
echo ""

# --- Preflight checks ---

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working directory is not clean."
  echo "Commit or stash changes before releasing."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Warning: releasing from branch '$BRANCH' (not main)"
  read -p "Continue? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# Check if tag already exists
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
  echo "Error: tag v$NEW_VERSION already exists."
  exit 1
fi

# --- Bump versions ---

echo "Bumping server version..."
cd apps/server
TMP=$(mktemp)
node -e "
  const pkg = require('./package.json');
  pkg.version = '$NEW_VERSION';
  process.stdout.write(JSON.stringify(pkg, null, 2) + '\n');
" > "$TMP"
mv "$TMP" package.json
cd "$REPO_ROOT"

# --- Commit and tag ---

git add apps/server/package.json
git commit -m "chore: bump version to $NEW_VERSION"
git tag "v$NEW_VERSION"

echo ""
echo "Created commit and tag v$NEW_VERSION"
echo ""
echo "To publish:"
echo "  git push origin main && git push origin v$NEW_VERSION"
echo ""
echo "CI will then:"
echo "  1. Build 0x0-server for all platforms"
echo "  2. Create a GitHub release with all artifacts"
echo "  3. Update the Homebrew tap with new checksums"
