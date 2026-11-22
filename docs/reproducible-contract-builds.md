# Reproducible Contract Builds and WASM Hash Verification

**GitHub issue:** [#237](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/237)

## Problem

Deployed WASM cannot currently be verified against source code. Anyone auditing
or using the wallet must trust that the on-chain bytecode matches what is
published in the repository. Without a reproducible build pipeline there is no
way to prove that claim.

## Threat Model

| Threat | Impact |
|---|---|
| Supply-chain compromise of a build dependency | Malicious bytecode deployed silently |
| Maintainer mistake (wrong local toolchain version) | Hash drift between deployments of the same commit |
| Tampered deployment artifact in CI | Contract differs from audited source |

## Design

### Pinned build container

All contract builds run inside a pinned Docker image that locks the Rust
toolchain version, `cargo-soroban` version, and `wasm-opt` version. The image
digest is committed to `contract/docker/builder.lock` so any toolchain change
requires an explicit, reviewable update.

```
contract/docker/
  Dockerfile.builder      # multi-stage build; final stage is debian-slim
  builder.lock            # sha256 digest of the published image
```

Builds outside CI must use this image too:

```bash
# build locally with the pinned container
make contract-build
# equivalent manual command
docker run --rm -v "$(pwd)/contract:/workspace" \
  $(cat contract/docker/builder.lock) \
  cargo build --release --target wasm32-unknown-unknown
```

### CI publishes hashes and attestations

After a successful build, CI:

1. Computes `sha256sum` of every `.wasm` artifact.
2. Signs the manifest with [cosign](https://github.com/sigstore/cosign) using
   the repository's OIDC identity (keyless mode; no private key to rotate).
3. Uploads the manifest and attestation as a build artifact and attaches them
   to the GitHub release.

The signed manifest format:

```json
{
  "commit": "6fc71e5...",
  "built_at": "2025-01-15T10:00:00Z",
  "artifacts": [
    {
      "name": "globe_wallet.wasm",
      "sha256": "abcdef1234..."
    }
  ]
}
```

### On-chain hash verification script

`contract/scripts/verify-deployment.sh` queries the Stellar RPC for the WASM
hash stored in the deployed contract and compares it against the signed release
manifest:

```bash
# verify testnet deployment
./contract/scripts/verify-deployment.sh \
  --network testnet \
  --contract-id $(jq -r .contract_id contract/deployments/testnet.json) \
  --manifest path/to/manifest.json

# expected output
✓ On-chain hash matches release manifest (sha256: abcdef1234...)
```

The script exits non-zero and prints a diff if there is a mismatch, making it
safe to run in CI on every deployment.

### Deployment record

`contract/deployments/testnet.json` and the forthcoming `mainnet.json` record
the WASM hash alongside the contract ID:

```json
{
  "network": "testnet",
  "contract_id": "C...",
  "wasm_hash": "abcdef1234...",
  "deployed_at_ledger": 123456,
  "manifest_url": "https://github.com/.../releases/tag/v1.2.3"
}
```

## Tasks

- [ ] Add pinned `Dockerfile.builder` and `builder.lock`
- [ ] Update `Makefile` with `contract-build` target that uses the pinned image
- [ ] Add CI step: compute hashes, sign with cosign, attach to release
- [ ] Write `contract/scripts/verify-deployment.sh`
- [ ] Update `contract/deployments/testnet.json` schema to include `wasm_hash` and `manifest_url`
- [ ] Update README and this doc once behaviour is live
- [ ] Add test: independent build of the same commit produces the same hash

## Test Plan

1. Check out commit `6fc71e5`, run `make contract-build`, confirm the output
   hash matches the hash published in the release manifest for that commit.
2. Modify a single comment in the contract source, rebuild, confirm the hash
   changes (guards against accidental stripping of debug symbols hiding
   meaningful diffs).
3. Run `verify-deployment.sh` against a testnet deployment where the WASM hash
   is known; confirm exit 0.
4. Swap the expected hash for a wrong value; confirm exit 1 and a clear error
   message.

## Acceptance Criteria

- An independent build of any tagged release produces a byte-for-byte identical
  WASM and matching SHA-256 hash.
- The signed manifest is published as a release artifact and verifiable with
  `cosign verify`.
- `verify-deployment.sh` passes against the testnet deployment in CI.
- CI is green (lint, type-check, tests).
- No new TODOs without a linked issue.

## References

- Deployment manifest: [`contract/deployments/testnet.json`](../contract/deployments/testnet.json)
- Deploy script: [`contract/scripts/deploy.sh`](../contract/scripts/deploy.sh)
- [Sigstore cosign](https://github.com/sigstore/cosign)
- [Soroban contract deployment docs](https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-to-testnet)
