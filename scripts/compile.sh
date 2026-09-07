#!/bin/bash

targets=(
  "linux-x64"
  "linux-arm64"
  "windows-x64"
  "windows-arm64"
  "darwin-x64"
  "darwin-arm64"
  "linux-x64-musl"
  "linux-arm64-musl"
)

rm -rf dist || exit 1
mkdir -p dist || exit 1

for target in "${targets[@]}"; do
  echo "Building $target..."
  dist_file="dist/lasso-$target"
  bun build --compile --minify --sourcemap --target="bun-$target" \
    ./src/index.ts --outfile "$dist_file" || exit 1
  if [[ -f "$dist_file.exe" ]]; then
    dist_file="$dist_file.exe"
  fi
  hashed="$(openssl dgst -sha256 "$dist_file" | cut -d' ' -f2)" || exit 1
  echo "$hashed" >"$dist_file.checksum"
done

echo "Built all targets into dist/"
