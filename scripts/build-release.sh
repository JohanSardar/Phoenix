#!/bin/sh
# Builds the release archives into <out-dir>: one per platform, each with the
# app and its production node_modules beside an official Node.js binary.
# Run from a clean checkout after `pnpm install --prod --frozen-lockfile`.
# Usage: scripts/build-release.sh <version> <out-dir>
set -eu

version=$1
out=$(mkdir -p "$2" && cd "$2" && pwd)
node_version=${NODE_VERSION:?set NODE_VERSION}
node_dist="https://nodejs.org/dist/v$node_version"

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$@"; }; else sha256() { shasum -a 256 "$@"; }; fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/app"
tar -cf - --exclude=./.git --exclude=./.github . | tar -xf - -C "$work/app"
curl -fsSL -o "$work/SHASUMS256.txt" "$node_dist/SHASUMS256.txt"

for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  name="node-v$node_version-$target"
  curl -fsSL -o "$work/$name.tar.gz" "$node_dist/$name.tar.gz"
  (cd "$work" && grep " $name.tar.gz\$" SHASUMS256.txt | sha256 -c -)
  stage="$work/stage-$target"
  mkdir -p "$stage/phoenix/node/bin"
  tar -xzf "$work/$name.tar.gz" -C "$work" "$name/bin/node" "$name/LICENSE"
  mv "$work/$name/bin/node" "$stage/phoenix/node/bin/node"
  mv "$work/$name/LICENSE" "$stage/phoenix/node/LICENSE"
  cp -R "$work/app" "$stage/phoenix/app"
  echo "$version" > "$stage/phoenix/VERSION"
  tar -czf "$out/phoenix-$target.tar.gz" -C "$stage" phoenix
done

cp install.sh "$out/install.sh"
(cd "$out" && sha256 phoenix-*.tar.gz install.sh > SHA256SUMS)
cat "$out/SHA256SUMS"
