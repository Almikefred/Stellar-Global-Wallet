# Multi-Network Safety: Preventing Testnet and Mainnet Mix-Ups

## Threat Model & Failure Modes

Signing or relaying a transaction against the wrong network (e.g. submitting a testnet-built envelope to mainnet, or vice-versa) can lead to unexpected account operations, replay attacks, or loss of user funds.

GlobeWallet implements four layers of defense to enforce network separation:

1. **Envelope Signature Verification**:
   Stellar transaction hashes are derived from the SHA-256 hash of the network passphrase combined with the transaction signature base. When an envelope is submitted (`/wallet/submit`, `/contract/wallet/submit`, `/wallet/submit-multisig`), `verifyEnvelopeNetwork` checks all signer hints and verifies signatures against the expected network hash. Any mismatch is rejected with code `WRONG_NETWORK`.

2. **Horizon & Soroban RPC Startup Verification**:
   At server boot, `assertNetworkConfigurationMatches()` queries:
   - `GET HORIZON_URL`: reads `network_passphrase` and checks equality with `NETWORK_PASSPHRASE`.
   - `POST SOROBAN_RPC_URL (getNetwork)`: reads `passphrase` and checks equality with `SOROBAN_NETWORK_PASSPHRASE`.
   - Validates that `STELLAR_NETWORK=mainnet` does not use the testnet passphrase, and vice-versa.
   If any discrepancy is detected, the process terminates immediately with exit code 1.

3. **Network-Scoped Cache & Storage Isolation**:
   All Redis keys and persistence identifiers are prefixed with `orbit-wal:<network>:...`:
   - `orbit-wal:<network>:soroban-cache:...`
   - `orbit-wal:<network>:json-cache:...`
   - `orbit-wal:<network>:notif-dedup:...`
   - `orbit-wal:<network>:account-lock:...`
   - `orbit-wal:<network>:session:...`
   Postgres tables (`pending_txs`, `idempotency_keys`) store a `network` column to prevent key collisions across deployments.

4. **Network Introspection Endpoint**:
   - `GET /api/v1/network/info`: returns the active network, passphrase, and upstream endpoints for client verification.
