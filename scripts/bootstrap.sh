#!/bin/sh
set -eu
setup_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$setup_root"
setup_mode=${1:-}
platform=$(uname -s)
case "$platform" in
  Darwin) platform=darwin ;;
  *) echo 'This installation entry supports macOS. Use Node.js 22+ and npm run setup on other systems.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'An x64 or ARM64 machine is required.' >&2; exit 1 ;;
esac
runtime_dir="$setup_root/.runtime/$platform-$arch"
node_path=''
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  node_path=$(command -v node)
elif [ -x "$runtime_dir/node/bin/node" ] && [ -f "$runtime_dir/node/lib/node_modules/npm/bin/npm-cli.js" ]; then
  node_path="$runtime_dir/node/bin/node"
fi
if [ -z "$node_path" ]; then
  if [ "$setup_mode" != '--setup' ]; then
    echo 'Node.js is missing or too old. Run the installation .command in the project root first.' >&2
    exit 1
  fi
  echo '[setup] Preparing a project-local Node.js 22 runtime...'
  if [ -z "${HTTPS_PROXY:-${https_proxy:-${ALL_PROXY:-}}}" ] && command -v nc >/dev/null 2>&1 && nc -z -w 1 127.0.0.1 7897 2>/dev/null; then
    HTTPS_PROXY=http://127.0.0.1:7897
    export HTTPS_PROXY
  fi
  mkdir -p "$runtime_dir"
  base=https://nodejs.org/download/release/latest-v22.x
  curl -fL --connect-timeout 15 --max-time 180 "$base/SHASUMS256.txt" -o "$runtime_dir/SHASUMS256.txt"
  archive=$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ /^node-v22\./ && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$runtime_dir/SHASUMS256.txt")
  if [ -z "$archive" ]; then echo 'No matching Node.js archive in the official release manifest.' >&2; exit 1; fi
  curl -fL --connect-timeout 15 --max-time 180 "$base/$archive" -o "$runtime_dir/$archive"
  expected=$(awk -v file="$archive" '$2==file {print $1}' "$runtime_dir/SHASUMS256.txt")
  actual=$(shasum -a 256 "$runtime_dir/$archive" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then echo 'Node.js download checksum mismatch. Run installation again.' >&2; exit 1; fi
  mkdir -p "$runtime_dir/node"
  tar -xzf "$runtime_dir/$archive" --strip-components=1 -C "$runtime_dir/node"
  node_path="$runtime_dir/node/bin/node"
fi
PATH="$(dirname "$node_path"):$PATH"
export PATH
if [ "$setup_mode" = '--setup' ]; then
  "$node_path" scripts/setup.js
  exec "$node_path" scripts/launch.js --no-build
fi
exec "$node_path" scripts/launch.js
