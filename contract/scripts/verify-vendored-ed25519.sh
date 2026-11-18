#!/usr/bin/env bash
# Issue #183: prove contract/vendor/ed25519-dalek-2.2.0 is a byte-for-byte
# copy of the crates.io release (no local patches), so the [patch.crates-io]
# entry in Cargo.toml only pins a version and never changes crypto code.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$here/vendor/ed25519-dalek-2.2.0"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# crates.io SHA-256 of ed25519-dalek-2.2.0.crate (from the index `cksum`).
expected="${ED25519_DALEK_CRATE_SHA256:-}"
curl -fsSL -o "$tmp/crate.tar.gz" https://static.crates.io/crates/ed25519-dalek/ed25519-dalek-2.2.0.crate
if [ -n "$expected" ]; then
  echo "$expected  $tmp/crate.tar.gz" | sha256sum -c -
fi
tar -xzf "$tmp/crate.tar.gz" -C "$tmp"
# .cargo_vcs_info.json / .cargo-checksum.json are packaging metadata only.
if diff -r -x .cargo_vcs_info.json -x .cargo-checksum.json -x Cargo.toml.orig \
    "$tmp/ed25519-dalek-2.2.0" "$vendor"; then
  echo "vendor/ed25519-dalek-2.2.0 matches crates.io 2.2.0 (no patches)"
else
  echo "::error::vendor/ed25519-dalek-2.2.0 differs from the crates.io release" >&2
  exit 1
fi
