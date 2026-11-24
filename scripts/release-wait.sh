#!/usr/bin/env bash
#
# The "Publish n8n node: npm" TeamCity build, run after the tag is set:
#
#     bash scripts/release-wait.sh <version>
#
# It waits for the GitHub Publish run of the tag, then checks npm has the version with a provenance statement,
# which n8n verification requires.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION="${1:?usage: bash scripts/release-wait.sh <version>}"

SCRATCH=()
cleanup() { [ ${#SCRATCH[@]} -eq 0 ] || rm -rf "${SCRATCH[@]}"; }
trap cleanup EXIT

# shellcheck source=scripts/node.sh
source scripts/node.sh
ensure_node

NAME=$(node -p "require('./package.json').name")
# owner/repo, read from package.json so a rename does not leave this script behind.
REPO=$(node -p "new URL(require('./package.json').repository.url.replace(/^git\+/, '')).pathname.replace(/^\//, '').replace(/\.git$/, '')")

echo "➡️ Waiting for the GitHub Publish run of tag ${VERSION} on ${REPO}"
# The tag reaches GitHub through the Gitea push mirror, then publish.yml runs: 20 minutes is far above both.
STATE="none"
for _ in $(seq 1 60); do
  RUNS=$(curl -fsS "https://api.github.com/repos/${REPO}/actions/runs?event=push&branch=${VERSION}&per_page=5" || echo '{}')
  STATE=$(printf '%s' "${RUNS}" | node scripts/publish-run-state.js)
  case "${STATE}" in completed*) break ;; esac
  sleep 20
done
echo "GitHub Publish run: ${STATE}"
case "${STATE}" in
  "completed success "*) ;;
  none) echo "❌ No GitHub Publish run for tag ${VERSION}: check the Gitea push mirror"; exit 1 ;;
  *) echo "❌ The GitHub Publish run did not succeed"; exit 1 ;;
esac

# The run has finished, but the registry can lag behind it by a little.
for _ in $(seq 1 30); do
  if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then break; fi
  sleep 10
done
PROVENANCE=$(npm view "${NAME}@${VERSION}" dist.attestations.provenance.predicateType)
if [ "${PROVENANCE}" != "https://slsa.dev/provenance/v1" ]; then
  echo "❌ ${NAME}@${VERSION} is not on npm with a provenance statement (got '${PROVENANCE}')"
  exit 1
fi
echo "✅ ${NAME}@${VERSION} is on npm, with provenance"
echo "##teamcity[buildNumber '${VERSION}']"
