#!/usr/bin/env bash
# Issue #183: build every contract for wasm32 and report WASM sizes, and fail
# if any contract WASM links ed25519-dalek (verification must use the
# `ed25519_verify` host function).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --workspace --release --target wasm32-unknown-unknown
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "| contract | wasm bytes |"
  echo "|---|---|"
  for f in target/wasm32-unknown-unknown/release/*.wasm; do
    echo "| $(basename "$f") | $(wc -c <"$f") |"
  done
} >>"$out"
if cargo tree --workspace -e normal --target wasm32-unknown-unknown -i ed25519-dalek 2>/dev/null | grep -q "ed25519-dalek"; then
  echo "::error::ed25519-dalek is a normal (WASM) dependency; use env.crypto().ed25519_verify" >&2
  exit 1
fi
