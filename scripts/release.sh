#!/bin/bash
set -euo pipefail

# Release script for nutrition-mcp
# Usage: ./scripts/release.sh [patch|minor|major]
#
# Steps:
#   1. Verify clean working tree
#   2. Run tests
#   3. Bump version (package.json, version.ts, plugin.json)
#   4. Build
#   5. Verify package contents
#   6. Commit version bump
#   7. Git tag
#   8. Publish to npm
#   9. Push to GitHub (only after successful publish)

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# 1. Must be on main with a clean working tree
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch to release (current: $CURRENT_BRANCH)."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# 2. Tests
echo "Running tests..."
npm test
echo ""

# 3. Bump version
OLD_VERSION=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version --no-commit-hooks > /dev/null
NEW_VERSION=$(node -p "require('./package.json').version")
echo "Version: $OLD_VERSION → $NEW_VERSION"

# Sync version.ts (portable — no sed)
node -e "
const fs = require('fs');
const f = 'src/version.ts';
fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/export const VERSION = \"[^\"]*\"/, 'export const VERSION = \"$NEW_VERSION\"'));
"

# Sync plugin.json (portable — no sed)
node -e "
const fs = require('fs');
const f = '.claude-plugin/plugin.json';
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
j.version = '$NEW_VERSION';
fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
"

# 4. Build (also validates TypeScript)
echo "Building..."
npm run build

# 5. Verify package contents
echo ""
echo "Package contents:"
npm pack --dry-run 2>&1 | tail -5
echo ""

# 6. Commit
git add package.json package-lock.json src/version.ts .claude-plugin/plugin.json
git commit -m "Release v$NEW_VERSION"

# 7. Tag
git tag "v$NEW_VERSION"

# 8. Publish (before push — if this fails, no tag/commit escapes to remote)
echo "Publishing to npm..."
npm publish --access public

# 9. Push (only after successful publish)
echo "Pushing to GitHub..."
git push origin main
git push origin "v$NEW_VERSION"

echo ""
echo "Released nutrition-mcp@$NEW_VERSION"
echo "  npm: https://www.npmjs.com/package/nutrition-mcp"
echo "  tag: https://github.com/daveremy/nutrition-mcp/releases/tag/v$NEW_VERSION"
