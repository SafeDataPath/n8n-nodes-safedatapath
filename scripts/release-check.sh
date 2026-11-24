#!/usr/bin/env bash
#
# The "Publish n8n node" TeamCity build, run from the repository root:
#
#     IS_DEFAULT_BRANCH=true bash scripts/release-check.sh
#
# It tests the node, then refuses a version npm already has. When it passes, TeamCity tags the commit with
# the version (VCS labeling), the Gitea push mirror carries the tag to GitHub, and .github/workflows/publish.yml
# publishes it to npm with provenance. scripts/release-wait.sh then checks the result.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCRATCH=()
cleanup() { [ ${#SCRATCH[@]} -eq 0 ] || rm -rf "${SCRATCH[@]}"; }
trap cleanup EXIT

# A release is cut from main only: the tag marks the commit tested here.
if [ "${IS_DEFAULT_BRANCH:-}" != "true" ]; then
  echo "❌ A release is cut from the default branch: run there, with IS_DEFAULT_BRANCH=true"
  exit 1
fi

# shellcheck source=scripts/node.sh
source scripts/node.sh
ensure_node

npm ci
npm run lint
npm run build
npm run typecheck:test

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
# The whole list, not npm view <name>@<version>: that one fails the same way when the version is missing and
# when npm cannot be reached, and the second must not read as "free to publish".
PUBLISHED=$(npm view "${NAME}" versions --json)
if printf '%s' "${PUBLISHED}" | node scripts/has-version.js "${VERSION}"; then
  echo "❌ ${NAME}@${VERSION} is already on npm: raise the version in package.json first"
  exit 1
fi
echo "✅ ${NAME}@${VERSION} is not on npm yet: the tag ${VERSION} will publish it"
# TeamCity tags the commit with the build number once the build has passed.
echo "##teamcity[buildNumber '${VERSION}']"
