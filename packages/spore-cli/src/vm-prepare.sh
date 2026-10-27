#!/bin/sh
# Brings a Debian vm to what spore needs: its packages, the Node the host runs, and the host's
# spore-cli. Each step looks first, so a second run changes nothing.
#   vm-prepare.sh <node version, as v24.11.1> <spore-cli version>
set -eu
node_version=$1
spore_version=$2

missing=
for package in curl xz-utils git kitty-terminfo; do
  dpkg -s "$package" >/dev/null 2>&1 || missing="$missing $package"
done
if [ -n "$missing" ]; then
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq $missing
fi

if [ "$(node --version 2>/dev/null || true)" != "$node_version" ]; then
  case $(uname -m) in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "no Node build for $(uname -m)" >&2; exit 1 ;;
  esac
  curl -fsSL "https://nodejs.org/dist/$node_version/node-$node_version-linux-$arch.tar.xz" |
    sudo tar -xJ -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE
fi

if [ "$(spore --version 2>/dev/null || true)" != "$spore_version" ]; then
  sudo npm install -g "@rhizogrip/spore-cli@$spore_version"
fi
