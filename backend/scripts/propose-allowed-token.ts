/**
 * Verifies an allowlist candidate is a genuine Stellar Asset Contract and
 * prints the `stellar contract invoke` command that proposes it (issue #189).
 * Refuses (exit 1) for any token that is not the SAC of the given asset.
 *
 *   npx tsx scripts/propose-allowed-token.ts <tokenId> <assetCode> [issuer]
 *
 * Uses SOROBAN_NETWORK_PASSPHRASE (default: testnet), GLOBE_WALLET_CONTRACT_ID
 * and ALLOWLIST_MANAGER (the source identity/account to sign with).
 */
import { Networks } from "@stellar/stellar-sdk";
import { verifyAllowlistCandidate } from "../src/services/contracts/sacVerification";

const [tokenId, assetCode, issuer] = process.argv.slice(2);
if (!tokenId || !assetCode) {
  console.error("usage: propose-allowed-token.ts <tokenId> <assetCode> [issuer]");
  process.exit(2);
}
const passphrase = process.env.SOROBAN_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const result = verifyAllowlistCandidate({ tokenId, assetCode, issuer: issuer ?? null }, passphrase);
if (!result.ok) {
  console.error(`${result.code}: ${result.message}`);
  if (result.expectedTokenId) console.error(`expected SAC id: ${result.expectedTokenId}`);
  process.exit(1);
}
const contract = process.env.GLOBE_WALLET_CONTRACT_ID ?? "<GLOBE_WALLET_CONTRACT_ID>";
const source = process.env.ALLOWLIST_MANAGER ?? "<allowlist-manager>";
const issuerArg = result.args.issuerKeyHex ? ` --issuer_key ${result.args.issuerKeyHex}` : "";
console.log(
  `stellar contract invoke --id ${contract} --source ${source} -- propose_allowed_token ` +
    `--caller ${source} --token_id ${result.args.tokenId} --asset_code ${result.args.assetCode}${issuerArg}`
);
console.log(
  "After ALLOWLIST_DELAY_LEDGERS (~1 day) run execute_allowed_token with the same --caller and --token_id."
);
