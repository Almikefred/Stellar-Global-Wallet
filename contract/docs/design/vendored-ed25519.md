# Vendored `ed25519-dalek` 2.2.0 (issue #183)

## Where it is used

`grep -rn ed25519 contracts/` shows **no contract source uses it**. It reaches
the build graph in two ways only:

| Consumer | Kind | In WASM? |
|---|---|---|
| `soroban-sdk` 21.7.7 / `soroban-env-host` 21.2.1 | transitive, `testutils` only | no |
| `smart-account` `[dev-dependencies]` | signs test payloads | no |

All on-chain signature verification (`smart-account::__check_auth`) uses the
host function `env.crypto().ed25519_verify`, which is metered, audited as part
of the Stellar host and costs nothing in WASM size.

## Why the vendor directory stays

It is a *version pin*, not a fork. `soroban-env-host` 21.2.1 declares
`ed25519-dalek = ">=2.0.0"` with no upper bound, so Cargo selects 3.x for it
while `soroban-sdk` stays on 2.x, and `cargo test` stops compiling. Cargo's
`[patch]` must point to a different source, the upstream repo has no `2.2.0`
tag, and `Cargo.lock` is gitignored, so a path patch to an unmodified copy is
the only portable fix (full reasoning in `contract/Cargo.toml`).

**Patch diff vs crates.io: empty.** CI enforces it: `scripts/verify-vendored-ed25519.sh`
downloads `ed25519-dalek-2.2.0.crate` from crates.io and `diff -r`s it with
the vendor directory (packaging metadata excluded). Any local change fails CI.

## Guards in CI (`.github/workflows/contract.yml`)

* `supply-chain` job: vendor diff, `cargo-deny` (advisories, licenses,
  sources, ban on `ed25519-dalek >= 3`, config in `contract/deny.toml`) and
  `cargo audit`. RustSec advisories against 2.2.0 therefore fail the build.
* `wasm-size` job (`scripts/wasm-size.sh`): builds every contract for
  `wasm32-unknown-unknown`, writes a size table to the job summary and fails
  if `ed25519-dalek` ever becomes a normal (WASM-linked) dependency.

## WASM size / CPU

Before and after this change the globe-wallet and token-wrapper WASM are
unchanged because neither ever linked the crate; the size table in the
`wasm-size` job summary is the record from now on. The new `smart-account`
verifies with the host function, so per-signature cost is the host's
`ed25519_verify` metering instead of tens of KB of curve arithmetic in WASM.

## Removal plan

Delete `vendor/` and the `[patch.crates-io]` entry when `soroban-sdk` is
upgraded past 21.x (later `soroban-env-host` releases bound the range).
