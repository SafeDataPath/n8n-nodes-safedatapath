#!/usr/bin/env bash
#
# The whole of the "n8n-node integration" build, run from the repository root:
#
#     bash n8n-nodes-sdp/test/integration/ci.sh
#
# It builds the community node, packs it the way npm would publish it, and installs the result on the n8n
# instance hosted on OVH, so that the SDP node and the SDP API credential appear in the editor.
#
# It lives in the repository rather than in the build configuration so it can be reviewed, and so a change
# to the deployment travels with the change to the node it deploys.
#
# What it expects from the build, and does not do itself:
#   - a Node 22 runtime (the build configuration runs this inside node:22)
#   - N8N_DEPLOY           "true" to install; anything else builds and packs only
#   - N8N_DEPLOY_KEY       the deployment account's private SSH key, as a secure build parameter
#   - N8N_DEPLOY_HOST_KEY  the server's public host key, one known_hosts line, as a build parameter
#
# Build and pack always run. Installing is opt-in because this configuration builds every branch
# (+:refs/heads/*) while there is a single n8n instance: without the guard, whichever branch happened to
# build last would silently replace the node everyone else is looking at.
set -euo pipefail

# Resolve the package directory from this script's own location, so the build can call it from the
# repository root and a developer can call it from anywhere.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "${SCRIPT_DIR}/../.." && pwd)

DEPLOY="${N8N_DEPLOY:-false}"
HOST="${N8N_DEPLOY_HOST:-vps-dfa08bb7.vps.ovh.net}"
SSH_USER="${N8N_DEPLOY_USER:-debian}"
CONTAINER="${N8N_CONTAINER:-n8n}"

# The node has to land inside the n8n container, under /home/node/.n8n, which is this named volume. Writing
# to ~/.n8n on the host achieves nothing: that directory does not exist there, and n8n never reads it.
VOLUME_DATA="${N8N_VOLUME_DATA:-/var/lib/docker/volumes/n8n_n8n_storage/_data}"

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
  echo "❌ N8N_DEPLOY_KEY is empty. Add it as a secure parameter holding the deployment private key."
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

echo "➡️ Installing on ${TARGET}"
ssh "${SSH_OPTS[@]}" "${TARGET}" 'echo "connected as $(whoami) on $(hostname)"'
scp "${SSH_OPTS[@]}" "${TARBALL}" "${TARGET}:/tmp/${TARBALL}"

# -------------------------------------------------------------------------------------------------------
# 3. Install, restart, verify
# -------------------------------------------------------------------------------------------------------

# Unquoted heredoc: ${TARBALL}, ${VOLUME_DATA} and ${CONTAINER} are substituted here, and everything the
# remote shell has to evaluate for itself is escaped as \$.
ssh "${SSH_OPTS[@]}" "${TARGET}" "bash -s" <<REMOTE
set -euo pipefail
VOL="${VOLUME_DATA}"
DEST="\${VOL}/custom/n8n-nodes-sdp"

# Every test below goes through sudo. /var/lib/docker is drwx--x--- root:root, so an unprivileged account
# cannot even stat inside it: a plain [ -d ] answers "no" for a directory that is there, and the script
# would stop on a message blaming the wrong thing.
if ! sudo test -d "\${VOL}"; then
  echo "❌ \${VOL} does not exist — the n8n volume is not where this script expects it"
  exit 1
fi

# Replace the directory rather than extract over it. The custom loader globs **/*.node.js recursively and
# never reads package.json, so a file left behind by an earlier version goes on being loaded, under its old
# name, with nothing to indicate that it is stale.
sudo rm -rf "\${DEST}"
sudo mkdir -p "\${DEST}"

# --strip-components=1 drops the package/ directory npm pack puts at the root of the archive.
sudo tar -xzf "/tmp/${TARBALL}" -C "\${DEST}" --strip-components=1

# node inside the container and debian on the host share uid 1000, so this is what the container sees.
sudo chown -R 1000:1000 "\${VOL}/custom"
rm -f "/tmp/${TARBALL}"

if ! sudo test -f "\${DEST}/dist/nodes/Sdp/Sdp.node.js"; then
  echo "❌ Sdp.node.js is missing from \${DEST} after extraction"
  exit 1
fi
echo "✅ extracted \$(sudo find "\${DEST}" -type f | wc -l) files"

# Custom directories are read at startup only, so the restart is not optional.
echo "➡️ Restarting ${CONTAINER}"
sudo docker restart "${CONTAINER}" >/dev/null

for i in \$(seq 1 30); do
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:5678/healthz || true)
  if [ "\${code}" = "200" ]; then
    echo "✅ n8n healthy after \${i} attempt(s)"
    break
  fi
  if [ "\${i}" = "30" ]; then
    echo "❌ n8n did not answer /healthz within 30 attempts; last status \${code}"
    sudo docker logs --tail 40 "${CONTAINER}"
    exit 1
  fi
  sleep 2
done

# A node that fails to load is reported in the log and nowhere else: n8n starts normally, and the node is
# simply absent from the editor.
if sudo docker logs --since 2m "${CONTAINER}" 2>&1 | grep -iE 'error loading|failed to load|cannot find module'; then
  echo "❌ n8n logged a loading error since the restart"
  exit 1
fi
REMOTE

echo "✅ n8n-nodes-sdp ${VERSION} installed on ${HOST}"
echo "   A node placed in custom/ does not show up under Settings → Community nodes: that page only lists"
echo "   what the interface installed, in ~/.n8n/nodes. Check it from the canvas — press Tab, search SDP."
