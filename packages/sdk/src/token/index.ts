/**
 * Token contract ids for spend limits (#173).
 *
 * The globe-wallet contract keys spend limits and daily-spent records by the
 * token *contract* id that `send` moves, not by a display code. Classic
 * Stellar assets are moved through their Stellar Asset Contract (SAC), whose
 * id is deterministic: derive it here instead of trusting a caller-supplied
 * code.
 */
import { Asset, StrKey } from "@stellar/stellar-sdk";

/** SAC contract id (`C...`) for a classic asset. `issuer` omitted/null = native XLM. */
export function sacTokenId(code: string, issuer: string | null | undefined, networkPassphrase: string): string {
  const asset = issuer ? new Asset(code, issuer) : Asset.native();
  return asset.contractId(networkPassphrase);
}

/** True for a well-formed contract id (`C...` strkey). */
export function isTokenId(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}
