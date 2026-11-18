import { Asset, StrKey } from "@stellar/stellar-sdk";

/**
 * Off-chain pre-flight for `propose_allowed_token` (issue #189).
 *
 * A Stellar Asset Contract's address is a pure function of the classic asset
 * it wraps and the network passphrase, so we derive it here and refuse to
 * build a proposal for any `tokenId` that does not match. The contract
 * performs the same derivation on-chain (`TokenNotStellarAsset`, #1040); this
 * check just lets admins catch a malicious or mistyped token before signing.
 */

export type SacVerificationCode =
  | "INVALID_TOKEN_ID"
  | "INVALID_ASSET_CODE"
  | "INVALID_ISSUER"
  | "TOKEN_NOT_STELLAR_ASSET";

export interface AllowlistProposalArgs {
  tokenId: string;
  assetCode: string;
  /** Issuer G-address, or null for native XLM. */
  issuer: string | null;
  /** Raw 32-byte ed25519 issuer key as hex (`issuer_key` arg), null for native. */
  issuerKeyHex: string | null;
}

export type SacVerificationResult =
  | { ok: true; args: AllowlistProposalArgs }
  | { ok: false; code: SacVerificationCode; message: string; expectedTokenId?: string };

const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

function isNative(assetCode: string, issuer: string | null | undefined): boolean {
  return (issuer === null || issuer === undefined || issuer === "") && assetCode === "XLM";
}

/** Contract id (C...) the network assigns to the SAC of `assetCode:issuer`. */
export function deriveSacContractId(
  assetCode: string,
  issuer: string | null,
  networkPassphrase: string
): string {
  const asset = isNative(assetCode, issuer) ? Asset.native() : new Asset(assetCode, issuer as string);
  return asset.contractId(networkPassphrase);
}

export function verifyAllowlistCandidate(
  input: { tokenId: string; assetCode: string; issuer?: string | null },
  networkPassphrase: string
): SacVerificationResult {
  const { tokenId, assetCode } = input;
  const issuer = input.issuer ?? null;
  if (typeof tokenId !== "string" || !StrKey.isValidContract(tokenId)) {
    return { ok: false, code: "INVALID_TOKEN_ID", message: "tokenId must be a valid C... contract address" };
  }
  if (typeof assetCode !== "string" || !ASSET_CODE.test(assetCode)) {
    return { ok: false, code: "INVALID_ASSET_CODE", message: "assetCode must be 1-12 alphanumeric characters" };
  }
  const native = isNative(assetCode, issuer);
  if (!native && (issuer === null || !StrKey.isValidEd25519PublicKey(issuer))) {
    return {
      ok: false,
      code: "INVALID_ISSUER",
      message: "issuer must be a valid G... account (omit it only for native XLM)",
    };
  }
  const expected = deriveSacContractId(assetCode, native ? null : issuer, networkPassphrase);
  if (expected !== tokenId) {
    return {
      ok: false,
      code: "TOKEN_NOT_STELLAR_ASSET",
      message: `tokenId is not the Stellar Asset Contract for ${native ? "native XLM" : `${assetCode}:${issuer}`}`,
      expectedTokenId: expected,
    };
  }
  return {
    ok: true,
    args: {
      tokenId,
      assetCode,
      issuer: native ? null : issuer,
      issuerKeyHex: native ? null : Buffer.from(StrKey.decodeEd25519PublicKey(issuer as string)).toString("hex"),
    },
  };
}
