#!/usr/bin/env bash
#
# The whole of the "n8n-node integration" build, run from the repository root:
#
#     bash n8n-nodes-sdp/test/integration/ci.sh
#
# It builds the community node, packs it the way npm would publish it, and hands the archive to the n8n
# host, so the SDP node and the SDP API credential appear in the editor.
#
# It lives in the repository rather than in the build configuration so it can be reviewed, and so a change
# to the deployment travels with the change to the node it deploys.
#
# What it expects from the build, and does not do itself:
#   - a Node 22 runtime (the build configuration runs this inside node:22). 22.13 is the real floor: the
#     n8n-node toolchain require()s an ES module, which older releases refuse.
#   - N8N_DEPLOY           "true" to install; anything else builds and packs only
#   - N8N_DEPLOY_KEY       the deploy-n8n private key, as a secure build parameter
#   - N8N_DEPLOY_HOST_KEY  the server's public host keys, known_hosts lines, as a build parameter
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

# -------------------------------------------------------------------------------------------------------
# 1. Build and pack
# -------------------------------------------------------------------------------------------------------

echo "➡️ Building n8n-nodes-sdp"
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

echo "➡️ Packing"
rm -f ./*.tgz
npm pack
TARBALL="n8n-nodes-sdp-${VERSION}.tgz"
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

SSH_DIR=$(mktemp -d)
# This directory holds a private key for as long as the step runs. Remove it however the step ends,
# including when a command fails under set -e or the build is cancelled.
trap 'rm -rf "${SSH_DIR}"' EXIT

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

echo "✅ n8n-nodes-sdp ${VERSION} installed on ${HOST}"
