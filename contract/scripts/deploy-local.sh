#!/usr/bin/env bash
# Builds and deploys the globe-wallet and token-wrapper contracts to the
# local `stellar/quickstart` network started with:
#   docker compose --profile local up -d stellar
# (see ../../docker-compose.yml), and records the resulting contract IDs in
# deployments/local.json so backend/.env or the local E2E suite (#232) can
# point GLOBE_WALLET_CONTRACT_ID at a real local deployment instead of testnet
# (issues #109, #232).
#
# Requires: stellar CLI (or legacy soroban CLI — override via SOROBAN_CLI),
# cargo with the wasm32-unknown-unknown target installed, and curl.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HORIZON_URL="${HORIZON_URL:-http://localhost:8000}"
RPC_URL="${RPC_URL:-${HORIZON_URL}/soroban/rpc}"
FRIENDBOT_URL="${FRIENDBOT_URL:-${HORIZON_URL}/friendbot}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
IDENTITY="${IDENTITY:-local-deployer}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-90}"
SKIP_BUILD="${SKIP_BUILD:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ -n "${SOROBAN_CLI:-}" ]; then
  CLI="$SOROBAN_CLI"
elif command -v stellar >/dev/null 2>&1; then
  CLI="stellar"
else
  CLI="soroban"
fi

if ! command -v "$CLI" >/dev/null 2>&1; then
  echo "ERROR: '$CLI' CLI not found on PATH. Install stellar-cli or set SOROBAN_CLI." >&2
  exit 1
fi

echo "==> Waiting for local Stellar Horizon ($HORIZON_URL) and Soroban RPC ($RPC_URL)"
READY=0
for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
  if curl -sf "${HORIZON_URL}/" >/dev/null 2>&1; then
    RPC_HEALTH="$(curl -sf -X POST "$RPC_URL" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || true)"
    if echo "$RPC_HEALTH" | grep -q '"healthy"'; then
      READY=1
      break
    fi
  fi
  if [ $((attempt % 10)) -eq 0 ]; then
    echo "    still waiting (${attempt}/${WAIT_ATTEMPTS})..."
  fi
  sleep 2
done

if [ "$READY" -ne 1 ]; then
  echo "ERROR: Local Stellar quickstart did not become healthy after $((WAIT_ATTEMPTS * 2))s." >&2
  exit 1
fi
echo "==> Local Stellar quickstart is healthy."

cd "$CONTRACT_DIR"
if [ "$SKIP_BUILD" != "1" ]; then
  echo "==> Building contracts (release, wasm32-unknown-unknown)"
  cargo build --target wasm32-unknown-unknown --release --workspace
else
  echo "==> Skipping cargo build (--skip-build)"
fi

echo "==> Ensuring deployer identity '$IDENTITY' exists and is funded"
if ! "$CLI" keys address "$IDENTITY" >/dev/null 2>&1; then
  "$CLI" keys generate "$IDENTITY" --network-passphrase "$NETWORK_PASSPHRASE"
fi
DEPLOYER_ADDRESS="$("$CLI" keys address "$IDENTITY")"

FUNDED=0
for _ in $(seq 1 15); do
  if curl -sf "${FRIENDBOT_URL}?addr=${DEPLOYER_ADDRESS}" >/dev/null 2>&1 \
    || curl -sf "${HORIZON_URL}/accounts/${DEPLOYER_ADDRESS}" >/dev/null 2>&1; then
    FUNDED=1
    break
  fi
  sleep 2
done

if [ "$FUNDED" -ne 1 ]; then
  echo "ERROR: Failed to fund deployer account ${DEPLOYER_ADDRESS} via Friendbot." >&2
  exit 1
fi

deploy() {
  local wasm_path="$1"
  if [ ! -f "$wasm_path" ]; then
    echo "ERROR: Built WASM not found at $wasm_path" >&2
    exit 1
  fi
  "$CLI" contract deploy \
    --wasm "$wasm_path" \
    --source "$IDENTITY" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    | tail -1
}

echo "==> Deploying globe-wallet"
GLOBE_WALLET_ID="$(deploy "$CONTRACT_DIR/target/wasm32-unknown-unknown/release/globe_wallet.wasm")"

echo "==> Deploying token-wrapper"
TOKEN_WRAPPER_ID="$(deploy "$CONTRACT_DIR/target/wasm32-unknown-unknown/release/token_wrapper.wasm")"

mkdir -p "$CONTRACT_DIR/deployments"
cat > "$CONTRACT_DIR/deployments/local.json" <<JSON
{
  "network": "local",
  "horizonUrl": "$HORIZON_URL",
  "rpcUrl": "$RPC_URL",
  "friendbotUrl": "$FRIENDBOT_URL",
  "networkPassphrase": "$NETWORK_PASSPHRASE",
  "deployerAddress": "$DEPLOYER_ADDRESS",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "globe-wallet": "$GLOBE_WALLET_ID",
    "token-wrapper": "$TOKEN_WRAPPER_ID"
  }
}
JSON

echo "==> Wrote $CONTRACT_DIR/deployments/local.json"
echo "    globe-wallet:   $GLOBE_WALLET_ID"
echo "    token-wrapper:  $TOKEN_WRAPPER_ID"
echo
echo "Point backend/.env at it with:"
echo "  HORIZON_URL=$HORIZON_URL"
echo "  NETWORK_PASSPHRASE=\"$NETWORK_PASSPHRASE\""
echo "  GLOBE_WALLET_CONTRACT_ID=$GLOBE_WALLET_ID"
echo "  TOKEN_WRAPPER_CONTRACT_ID=$TOKEN_WRAPPER_ID"
echo "  SOROBAN_RPC_URL=$RPC_URL"
echo "  SOROBAN_NETWORK_PASSPHRASE=\"$NETWORK_PASSPHRASE\""
