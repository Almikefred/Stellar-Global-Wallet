import * as StellarSdk from "@stellar/stellar-sdk";
import { AppError, NotFoundError } from "../errors/appError";
import { isGAddress } from "../utils/stellarAddress";
import { TtlCache } from "./ttlCache";

export const FEDERATION_TIMEOUT_MS = 3000;
const FEDERATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60s negative cache

export type ResolvedAddressType = "account" | "muxed" | "federation";

export interface ResolvedAddress {
  query?: string;
  type: ResolvedAddressType;
  /** Base G... account ID to pay. */
  accountId: string;
  /** Memo the federation server says to attach (federation only). */
  memo?: string;
  memoType?: "text" | "id" | "hash";
  /** Muxed sub-account ID as a decimal string (muxed only). */
  muxedId?: string;
  /** The muxed M... address to use as the payment destination (muxed only). */
  muxedAddress?: string;
}

export interface FederationRecord {
  account_id: string;
  memo_type?: string;
  memo?: string;
}

export type FederationResolver = (
  address: string,
  options: { timeout: number }
) => Promise<FederationRecord>;

const defaultResolver: FederationResolver = (address, options) =>
  StellarSdk.Federation.Server.resolve(address, options) as Promise<FederationRecord>;

const FEDERATION_ADDRESS = /^[^*\s]+\*([a-z0-9.-]+\.[a-z]{2,})$/i;

// SSRF blocklist: private, local, and metadata network ranges
const FORBIDDEN_DOMAINS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "169.254.169.254", // AWS/Cloud metadata
  "metadata.google.internal",
];

export function isSsrfSafeDomain(domain: string): boolean {
  const d = domain.toLowerCase().trim();
  if (FORBIDDEN_DOMAINS.includes(d)) return false;
  if (d.endsWith(".local") || d.endsWith(".internal") || d.endsWith(".lan") || d.endsWith(".arpa")) {
    return false;
  }
  // Reject IPv4 address literals
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(d)) return false;
  // Reject IPv6 address literals
  if (d.includes(":")) return false;
  return true;
}

export class FederationTimeoutError extends AppError {
  constructor(address: string) {
    super(`Federation server for ${address} did not respond within ${FEDERATION_TIMEOUT_MS}ms`, {
      code: "FEDERATION_TIMEOUT",
      retryable: true,
      status: 504,
    });
  }
}

export class FederationUnavailableError extends AppError {
  constructor(address: string, message?: string) {
    super(message ?? `Could not resolve ${address}: the domain has no reachable federation server`, {
      code: "FEDERATION_UNAVAILABLE",
      retryable: true,
      status: 502,
    });
  }
}

export class InvalidAddressError extends AppError {
  constructor(message: string) {
    super(message, { code: "INVALID_ADDRESS", status: 400 });
  }
}

export class InvalidFederationResponseError extends AppError {
  constructor(address: string, reason: string) {
    super(`Federation server returned invalid response for ${address}: ${reason}`, {
      code: "FEDERATION_INVALID_RESPONSE",
      status: 502,
    });
  }
}

export function isFederationAddress(value: string): boolean {
  return FEDERATION_ADDRESS.test(value);
}

export function isMuxedAddress(value: string): boolean {
  return StellarSdk.StrKey.isValidMed25519PublicKey(value);
}

export function isResolvableAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (isGAddress(value) || isMuxedAddress(value) || isFederationAddress(value))
  );
}

/** Validate memo against memo_type per SEP-2 and Stellar transaction rules */
export function validateFederationMemo(memo: unknown, memoType?: string): { memo?: string; memoType?: "text" | "id" | "hash" } {
  if (memo === undefined || memo === null || memo === "") {
    return {};
  }

  const memoStr = String(memo);
  const type = memoType?.toLowerCase() ?? "text";

  if (type === "id") {
    // Unsigned 64-bit integer
    if (!/^\d+$/.test(memoStr)) {
      throw new Error(`id memo must be an unsigned 64-bit integer: "${memoStr}"`);
    }
    const val = BigInt(memoStr);
    if (val < 0n || val > 18446744073709551615n) {
      throw new Error(`id memo out of 64-bit bounds: "${memoStr}"`);
    }
    return { memo: memoStr, memoType: "id" };
  }

  if (type === "hash") {
    // 32-byte hex (64 hex characters) or base64 (44 characters)
    if (/^[0-9a-f]{64}$/i.test(memoStr)) {
      return { memo: memoStr.toLowerCase(), memoType: "hash" };
    }
    if (/^[A-Za-z0-9+/]{43}=?$/.test(memoStr)) {
      return { memo: memoStr, memoType: "hash" };
    }
    throw new Error(`hash memo must be 32-byte hex or base64: "${memoStr}"`);
  }

  if (type === "text") {
    // Text memo at most 28 bytes UTF-8
    const byteLength = Buffer.byteLength(memoStr, "utf8");
    if (byteLength > 28) {
      throw new Error(`text memo exceeds 28-byte limit (${byteLength} bytes): "${memoStr}"`);
    }
    return { memo: memoStr, memoType: "text" };
  }

  throw new Error(`unsupported federation memo_type: "${type}"`);
}

export class FederationService {
  private readonly cache = new TtlCache<ResolvedAddress>(FEDERATION_CACHE_TTL_MS);
  private readonly negativeCache = new TtlCache<AppError>(NEGATIVE_CACHE_TTL_MS);

  constructor(private readonly resolver: FederationResolver = defaultResolver) {}

  async resolveAddress(q: string): Promise<ResolvedAddress> {
    const trimmed = q.trim();

    if (isGAddress(trimmed)) {
      return { query: trimmed, type: "account", accountId: trimmed };
    }

    if (isMuxedAddress(trimmed)) {
      const muxed = StellarSdk.MuxedAccount.fromAddress(trimmed, "0");
      return {
        query: trimmed,
        type: "muxed",
        accountId: muxed.baseAccount().accountId(),
        muxedId: muxed.id(),
        muxedAddress: trimmed,
      };
    }

    if (isFederationAddress(trimmed)) {
      return this.resolveFederation(trimmed);
    }

    throw new InvalidAddressError(
      "q must be a Stellar account (G...), a muxed account (M...) or a federation address (name*domain.com)"
    );
  }

  private async resolveFederation(address: string): Promise<ResolvedAddress> {
    const match = FEDERATION_ADDRESS.exec(address);
    if (!match) {
      throw new InvalidAddressError("Invalid federation address format");
    }
    const domain = match[1];

    // SSRF hardening: verify domain is public and safe
    if (!isSsrfSafeDomain(domain)) {
      throw new InvalidAddressError(`Domain "${domain}" is not allowed for federation lookup`);
    }

    // Check negative cache
    const cachedErr = this.negativeCache.get(address);
    if (cachedErr) {
      throw cachedErr;
    }

    // Check positive cache
    const cached = this.cache.get(address);
    if (cached) {
      return cached;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FederationTimeoutError(address)), FEDERATION_TIMEOUT_MS);
    });

    let record: FederationRecord;
    try {
      record = await Promise.race([
        this.resolver(address, { timeout: FEDERATION_TIMEOUT_MS }),
        timeout,
      ]);
    } catch (err) {
      const classified = classifyFederationError(err, address);
      this.negativeCache.set(address, classified);
      throw classified;
    } finally {
      clearTimeout(timer);
    }

    // Strict account ID validation
    if (!record || typeof record !== "object" || !record.account_id || !isGAddress(record.account_id)) {
      const err = new InvalidFederationResponseError(
        address,
        `account_id must be a valid G... Stellar address, received "${record?.account_id}"`
      );
      this.negativeCache.set(address, err);
      throw err;
    }

    // Strict memo validation
    let memoInfo: { memo?: string; memoType?: "text" | "id" | "hash" } = {};
    try {
      memoInfo = validateFederationMemo(record.memo, record.memo_type);
    } catch (err) {
      const validationErr = new InvalidFederationResponseError(address, (err as Error).message);
      this.negativeCache.set(address, validationErr);
      throw validationErr;
    }

    const result: ResolvedAddress = {
      query: address,
      type: "federation",
      accountId: record.account_id,
      ...memoInfo,
    };

    this.cache.set(address, result);
    return result;
  }
}

function classifyFederationError(err: unknown, address: string): AppError {
  if (err instanceof AppError) return err;

  const e = err as { code?: string; message?: string; response?: { status?: number } };
  if (e?.response?.status === 404) {
    return new NotFoundError(`Federation address ${address} was not found`, "FEDERATION_NOT_FOUND");
  }
  if (e?.code === "ECONNABORTED" || /timeout/i.test(e?.message ?? "")) {
    return new FederationTimeoutError(address);
  }
  return new FederationUnavailableError(address);
}
