#!/usr/bin/env bash
#
# The whole of the "n8n-node integration" build, run from the repository root:
#
#     bash test/integration/ci.sh
#
# It builds the community node, packs it the way npm would publish it, and hands the archive to the n8n
# host, so the SDP node and the SDP API credential appear in the editor.
#
# It lives in the repository rather than in the build configuration so it can be reviewed, and so a change
# to the deployment travels with the change to the node it deploys.
#
# What it expects from the build, and does not do itself:
#   - curl, tar, xz, sha256sum, git and an ssh client on the agent. Not Node: the agents run 20.20, below
#     what the toolchain accepts, so the script fetches a pinned Node 22 when it has to.
#   - N8N_DEPLOY           "true" to install; anything else builds and packs only
#   - N8N_DEPLOY_KEY       the deploy-n8n private key, as a secure build parameter
#   - N8N_DEPLOY_HOST_KEY  the server's public host keys, known_hosts lines, as a build parameter
#   - SDP_URL              optional, the SDP root the credentials point at (default https://n8n.safedatapath.eu);
#                          required once installing, for the capture suite
#   - N8N_API_KEY          the n8n public API key, to check the install and run the capture suite
#   - SDP_API_KEY          an AGENT key of the SDP tenant that reads this n8n back, for the capture suite
#
# Build and pack always run. Installing is opt-in because this configuration builds every branch
# (+:refs/heads/*) while there is a single n8n instance: without the guard, whichever branch built last
# would silently replace the node everyone else is looking at.
#
# Nothing here runs a command of its own choosing on the server. The archive is copied to a fixed path the
# deployment account owns, and one argument-less command is invoked; everything that needs root — reading
# the docker volume, replacing the directory, restarting the container — lives in that command, on the
# host, where it can be audited. See ovh/vps-n8n/usr/local/sbin/install-n8n-node in the infra repository.
set -euo pipefail

# Resolve the package directory from this script's own location, so the build can call it from the
# repository root and a developer can call it from anywhere.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "${SCRIPT_DIR}/../.." && pwd)

DEPLOY="${N8N_DEPLOY:-false}"
HOST="${N8N_DEPLOY_HOST:-vps-dfa08bb7.vps.ovh.net}"
SSH_USER="${N8N_DEPLOY_USER:-deploy-n8n}"
INCOMING="${N8N_DEPLOY_INCOMING:-/var/lib/n8n-node-deploy/incoming.tgz}"
INSTALLER="${N8N_DEPLOY_INSTALLER:-/usr/local/sbin/install-n8n-node}"

cd "${PKG_DIR}"

# One trap for the whole script. Two `trap ... EXIT` lines would not stack: the second replaces the first,
# and whatever the first was meant to remove stays behind — here, a private key.
SCRATCH=()
cleanup() { [ ${#SCRATCH[@]} -eq 0 ] || rm -rf "${SCRATCH[@]}"; }
trap cleanup EXIT

# -------------------------------------------------------------------------------------------------------
# 0. A Node the toolchain will accept
# -------------------------------------------------------------------------------------------------------

# scripts/node.sh holds the reasons and the pinned version; the release scripts use it too.
# shellcheck source=scripts/node.sh
source "${PKG_DIR}/scripts/node.sh"
ensure_node

# -------------------------------------------------------------------------------------------------------
# 1. Build and pack
# -------------------------------------------------------------------------------------------------------

NAME=$(node -p "require('./package.json').name")
echo "➡️ Building ${NAME}"
npm ci
npm run build

VERSION=$(node -p "require('./package.json').version")
if [ -z "${VERSION}" ]; then
  echo "❌ Could not read the version out of package.json"
  exit 1
fi

# package.json declares files: ["dist"], so a node that compiled to nothing packs successfully all the same
# and installs an empty directory. n8n then starts without complaint and simply shows no SDP node, with
# nothing in any log to say why. Check the two entry points the manifest promises before going further.
for f in dist/nodes/Sdp/Sdp.node.js dist/credentials/SdpApi.credentials.js; do
  if [ ! -f "${f}" ]; then
    echo "❌ The build did not produce ${f}, which package.json declares under \"n8n\""
    exit 1
  fi
done

# The credentials point at https://n8n.safedatapath.eu. SDP_URL points them at another SDP (a test one).
# It must be the SDP root: the OAuth2 credential adds /trial itself.
SDP_URL="${SDP_URL:-}"
if [ -n "${SDP_URL}" ]; then
  SDP_URL="${SDP_URL%/}"
  if ! [[ "${SDP_URL}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "❌ SDP_URL must be the SDP root, like https://sdp.example.com, not \"${SDP_URL}\""
    exit 1
  fi
  echo "➡️ Pointing the SDP credentials at ${SDP_URL}"
  SDP_URL="${SDP_URL}" node -e '
    const fs = require("fs");
    const from = "default: '"'"'https://n8n.safedatapath.eu'"'"'";
    const to = "default: '"'"'" + process.env.SDP_URL + "'"'"'";
    for (const f of ["dist/credentials/SdpApi.credentials.js", "dist/credentials/SdpOAuth2Api.credentials.js"]) {
      const s = fs.readFileSync(f, "utf8");
      if (s.split(from).length !== 2) { console.error("❌ Expected one default URL in " + f); process.exit(1); }
      fs.writeFileSync(f, s.replace(from, to));
    }'
fi

echo "➡️ Packing"
rm -f ./*.tgz
npm pack
# npm names the archive of @scope/name scope-name-<version>.tgz.
TARBALL="$(printf '%s' "${NAME}" | sed 's#^@##; s#/#-#')-${VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "❌ npm pack did not produce ${TARBALL}"
  exit 1
fi
echo "✅ ${TARBALL} — $(wc -c < "${TARBALL}") bytes"

if [ "${DEPLOY}" != "true" ]; then
  echo "ℹ️ N8N_DEPLOY is not \"true\": the package was built but not installed."
  exit 0
fi

# -------------------------------------------------------------------------------------------------------
# 2. SSH, set up inside the build container
# -------------------------------------------------------------------------------------------------------

# node:22 is Debian-based and ships no ssh client.
if ! command -v ssh >/dev/null 2>&1; then
  echo "➡️ Installing openssh-client"
  if ! (apt-get update -qq && apt-get install -y -qq openssh-client >/dev/null); then
    echo "❌ No ssh client, and installing one failed — the step is probably not running as root."
    echo "   Give the build an image that already has openssh-client."
    exit 1
  fi
fi

if [ -z "${N8N_DEPLOY_KEY:-}" ]; then
  echo "❌ N8N_DEPLOY_KEY is empty. It holds the deploy-n8n private key, as a secure parameter."
  exit 1
fi

# This directory holds a private key for as long as the step runs. The trap above removes it however the
# step ends, including when a command fails under set -e or the build is cancelled.
SSH_DIR=$(mktemp -d); SCRATCH+=("${SSH_DIR}")

KEY="${SSH_DIR}/id_deploy"
# printf rather than echo: a key read out of a build parameter often arrives without its final newline, and
# OpenSSH then rejects the file as "invalid format" without saying what is missing.
printf '%s\n' "${N8N_DEPLOY_KEY}" > "${KEY}"
chmod 600 "${KEY}"

KNOWN="${SSH_DIR}/known_hosts"
if [ -n "${N8N_DEPLOY_HOST_KEY:-}" ]; then
  printf '%s\n' "${N8N_DEPLOY_HOST_KEY}" > "${KNOWN}"
  HOST_CHECK=(-o StrictHostKeyChecking=yes)
else
  # Trust on first use protects nothing against someone already in position, so this is a fallback and not
  # the intent. Set N8N_DEPLOY_HOST_KEY and this branch stops being taken.
  echo "⚠️ N8N_DEPLOY_HOST_KEY is not set — accepting whatever host key the server presents."
  : > "${KNOWN}"
  HOST_CHECK=(-o StrictHostKeyChecking=accept-new)
fi

SSH_OPTS=(-i "${KEY}" -o "UserKnownHostsFile=${KNOWN}" "${HOST_CHECK[@]}" -o ConnectTimeout=20 -o BatchMode=yes)
TARGET="${SSH_USER}@${HOST}"

# -------------------------------------------------------------------------------------------------------
# 3. Hand it over
# -------------------------------------------------------------------------------------------------------

echo "➡️ Copying to ${TARGET}:${INCOMING}"
scp "${SSH_OPTS[@]}" "${TARBALL}" "${TARGET}:${INCOMING}"

# No arguments: sudoers allows this command and only this command, with none. The installer validates the
# archive, replaces the directory, restarts the container and reports — its output is this step's output.
echo "➡️ Running ${INSTALLER}"
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo ${INSTALLER}"

echo "✅ ${NAME} ${VERSION} installed on ${HOST}"

# -------------------------------------------------------------------------------------------------------
# 4. Ask n8n whether it actually loaded any of it
# -------------------------------------------------------------------------------------------------------

# Files in the right directory are not the same thing as a node n8n knows about, and until now the build
# could not tell the two apart. n8n's public API has no endpoint listing node types, and creating a
# workflow proves nothing — it accepts a node type that does not exist. What does discriminate is the
# credential schema: /credentials/schema/<type> answers 200 only for a type the instance has loaded, and
# 404 otherwise. Our package ships SdpApi.credentials.js beside Sdp.node.js, so this exercises the loader
# on the directory the installer just replaced. The control case below is what makes it a test rather than
# a reflex: an endpoint that answered 200 to everything would prove nothing.
API_URL="${N8N_URL:-https://${HOST}}"
REPORT="${PKG_DIR}/integration-results.xml"

emit_report() {
  # The build configuration watches integration-results.xml. Writing it here is what turns a
  # green step into a reported test.
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' "$1" > "${REPORT}"
  echo "ℹ️ report written to ${REPORT}"
}

if [ -z "${N8N_API_KEY:-}" ]; then
  echo "⚠️ N8N_API_KEY is not set — the node was installed but nothing checked it."
  emit_report '<testsuite name="n8n node integration" tests="1" failures="0" errors="0" skipped="1">
  <testcase classname="n8n.deployment" name="sdp credential type is loaded">
    <skipped message="N8N_API_KEY is not set"/>
  </testcase>
</testsuite>'
  exit 0
fi

probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
            "${API_URL}/api/v1/credentials/schema/$1"; }

echo "➡️ Asking ${API_URL} which credential types it knows"

# /healthz answers 200 before n8n has finished scanning the custom directory, and so does
# /healthz/readiness — measured on build 6523, which got 404 one second after the installer reported the
# container healthy, then 200 a few minutes later. Neither endpoint is a signal that the nodes are loaded,
# so the only honest way to wait is to keep asking the question. A node that never loads still fails, it
# just takes a minute to say so.
LOADED=000
for attempt in $(seq 1 30); do
  LOADED=$(probe sdpApi)
  if [ "${LOADED}" = "200" ]; then
    echo "   sdpApi -> 200 after ${attempt} attempt(s)"
    break
  fi
  sleep 2
done
[ "${LOADED}" = "200" ] || echo "   sdpApi -> ${LOADED} after 30 attempts"

CONTROL=$(probe n8nNodesSdpControlCaseThatMustNotExist)
echo "   control -> ${CONTROL}"

FAILS=0
CASES=""
if [ "${LOADED}" = "200" ]; then
  CASES="${CASES}  <testcase classname=\"n8n.deployment\" name=\"sdp credential type is loaded\"/>
"
else
  FAILS=$((FAILS + 1))
  CASES="${CASES}  <testcase classname=\"n8n.deployment\" name=\"sdp credential type is loaded\">
    <failure message=\"expected 200 from /credentials/schema/sdpApi, got ${LOADED}\"/>
  </testcase>
"
fi
if [ "${CONTROL}" = "404" ]; then
  CASES="${CASES}  <testcase classname=\"n8n.deployment\" name=\"unknown credential type is rejected\"/>
"
else
  FAILS=$((FAILS + 1))
  CASES="${CASES}  <testcase classname=\"n8n.deployment\" name=\"unknown credential type is rejected\">
    <failure message=\"expected 404 for a type that does not exist, got ${CONTROL} — this endpoint is not discriminating, so the check above proves nothing\"/>
  </testcase>
"
fi

emit_report "<testsuite name=\"n8n node integration\" tests=\"2\" failures=\"${FAILS}\" errors=\"0\">
${CASES}</testsuite>"

if [ "${FAILS}" -ne 0 ]; then
  echo "❌ n8n does not report the node as loaded"
  exit 1
fi
echo "✅ n8n reports the SDP credential type as loaded, and rejects one that does not exist"

# -------------------------------------------------------------------------------------------------------
# 5. Run workflows through the node, and ask SDP whether it captured them
# -------------------------------------------------------------------------------------------------------

# A loaded credential type says nothing about the node at run time. The suite drives real runs on the
# instance and reads each capture back from SDP (capture.test.mts), into integration-capture.xml.
# Skipped, not failed, while TeamCity has no SDP key yet (FCT-1650): it shows as a skipped test, not a green one.
if [ -z "${SDP_API_KEY:-}" ] || [ -z "${SDP_URL}" ]; then
  echo "⚠️ SDP_URL or SDP_API_KEY is not set: the capture suite did not run."
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<testsuite name="n8n node capture" tests="1" failures="0" errors="0" skipped="1">' \
    '  <testcase classname="n8n.capture" name="capture suite">' \
    '    <skipped message="SDP_URL or SDP_API_KEY is not set"/>' \
    '  </testcase>' \
    '</testsuite>' > "${PKG_DIR}/integration-capture.xml"
  exit 0
fi
echo "➡️ Running the capture suite against ${API_URL} and ${SDP_URL}"
npm run typecheck:test
N8N_URL="${API_URL}" SDP_URL="${SDP_URL}" npm run test:integration
echo "✅ The capture suite passed"
