# Sourced, not run: puts a Node the toolchain accepts first on the PATH. Used by test/integration/ci.sh and
# by the release scripts, which run on TeamCity agents that carry an older Node.
#
# @n8n/node-cli require()s an ES module, which Node refuses before 22.13: the error is ERR_REQUIRE_ESM and
# it names a file deep in node_modules, so it reads as a broken dependency rather than an old runtime.
# package.json claims engines >= 20.15, which is simply wrong; npm itself warns that the real floor is
# ^20.19 || ^22.13. The agents run 20.20, so the scripts provide their own rather than wait for the image.

node_is_recent_enough() {
  command -v node >/dev/null 2>&1 || return 1
  local maj min
  maj=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null) || return 1
  min=$(node -p "process.versions.node.split('.')[1]" 2>/dev/null) || return 1
  [ "${maj}" -gt 22 ] && return 0
  [ "${maj}" -eq 22 ] && [ "${min}" -ge 13 ] && return 0
  return 1
}

ensure_node() {
  if node_is_recent_enough; then
    echo "➡️ Node $(node --version)"
    return 0
  fi
  # Pinned, not "latest 22": a build that picks up whatever is current today is a build that cannot be
  # reproduced tomorrow.
  local version="${NODE_VERSION:-v22.23.3}"
  echo "➡️ Node $(node --version 2>/dev/null || echo 'absent') is too old; fetching ${version}"
  local dir archive base
  dir=$(mktemp -d)
  # Removed by the caller's cleanup when it keeps a SCRATCH list, as every script here does.
  if declare -p SCRATCH >/dev/null 2>&1; then SCRATCH+=("${dir}"); fi
  archive="node-${version}-linux-x64.tar.xz"
  base="https://nodejs.org/dist/${version}"
  curl -fsSL --max-time 300 -o "${dir}/${archive}" "${base}/${archive}"
  curl -fsSL --max-time 60  -o "${dir}/SHASUMS256.txt" "${base}/SHASUMS256.txt"
  # The checksum and the archive come from the same host, so this catches a truncated download, not a
  # compromised mirror. The trust here is TLS and the nodejs.org name; proving more would mean verifying
  # the release signature, which needs a keyring the build does not carry.
  ( cd "${dir}" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c - ) \
    || { echo "❌ checksum mismatch on ${archive}"; exit 1; }
  tar -xJf "${dir}/${archive}" -C "${dir}"
  export PATH="${dir}/node-${version}-linux-x64/bin:${PATH}"
  node_is_recent_enough || { echo "❌ still on $(node --version) after fetching ${version}"; exit 1; }
  echo "✅ Node $(node --version), npm $(npm --version)"
}
