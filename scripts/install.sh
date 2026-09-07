#!/usr/bin/env bash

set -euo pipefail

repository="elanmed/lasso"
os="$(uname -s)"
architecture="$(uname -m)"

case "$os" in
  Darwin)
    platform="darwin"
    ;;
  Linux)
    platform="linux"
    ;;
  *)
    printf 'Unsupported operating system: %s\n' "$os" >&2
    exit 1
    ;;
esac

case "$architecture" in
  x86_64 | amd64)
    architecture="x64"
    ;;
  arm64 | aarch64)
    architecture="arm64"
    ;;
  *)
    printf 'Unsupported architecture: %s\n' "$architecture" >&2
    exit 1
    ;;
esac

asset="lasso-${platform}-${architecture}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
install_dir="$data_home/lasso"
binary="$install_dir/$asset"
link="$bin_home/lasso"
url="https://github.com/$repository/releases/latest/download/$asset"
checksum_url="$url.checksum"
temporary="$binary.tmp.$"
checksum_temporary="$temporary.checksum"

cleanup() {
  rm -f "$temporary" "$checksum_temporary"
}
trap cleanup EXIT

mkdir -p "$install_dir" "$bin_home"
printf 'Downloading %s...\n' "$url"
curl --fail --location --silent --show-error "$url" --output "$temporary"
curl --fail --location --silent --show-error "$checksum_url" --output "$checksum_temporary"

expected_checksum="$(cut -d' ' -f1 "$checksum_temporary")"
if [[ ! $expected_checksum =~ ^[[:xdigit:]]{64}$ ]]; then
  printf 'Invalid checksum file: %s\n' "$checksum_url" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  printf 'openssl is required to verify the checksum\n' >&2
  exit 1
fi
actual_checksum="$(openssl dgst -sha256 "$temporary" | cut -d' ' -f2)"

if [[ $actual_checksum != "$expected_checksum" ]]; then
  printf 'Checksum verification failed for %s\n' "$asset" >&2
  exit 1
fi

chmod 755 "$temporary"
mv "$temporary" "$binary"

if [[ -e $link && ! -L $link ]]; then
  printf 'Cannot replace existing non-symlink: %s\n' "$link" >&2
  exit 1
fi
ln -sfn "$binary" "$link"
printf 'Installed lasso at %s\n' "$link"
