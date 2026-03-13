#!/bin/bash
set -euo pipefail

echo "Building..."
npm run build

echo "Running tests..."
npm test

echo "Checking package contents..."
npm pack --dry-run

echo ""
echo "Ready to publish. Run:"
echo "  npm publish"
