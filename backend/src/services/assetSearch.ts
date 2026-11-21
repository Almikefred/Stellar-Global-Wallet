/**
 * Asset search for the add-trustline flow (issue #53).
 *
 * Typing "USDC" matches dozens of issuers on mainnet, most of them
 * lookalikes. This proxies Horizon's `/assets?asset_code=` and reorders the
 * page so curated verified issuers (see verifiedAssets.ts) come first, then
 * the rest by number of trustlines, descending.
 *
 * Two modes:
 *   - `code`: Horizon `/assets?asset_code=CODE&order=desc&limit=N`, cursor
 *     paginated. On the first page, verified issuers for CODE that Horizon
 *     didn't happen to return are fetched individually and included, so
 *     the right answer is always on page one.
 *   - `domain`: the CODE:ISSUER pairs that domain's stellar.toml lists and
 *     whose issuer's `home_domain` confirms it (AssetMetadataService).
 *     Single page, no cursor.
 *
 * Sorting happens within a page: Horizon itself can't order by trustline
 * count, so page 2 is not guaranteed to have fewer holders than page 1.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { AssetSearchPage, AssetSearchResult, RiskFactor } from "@stellar-global-wallet/types";
import { config } from "../config";
import { HorizonError } from "../errors/appError";
import { AssetMetadataService } from "./assetMetadata";
import { VerifiedAssetRegistry, createVerifiedAssetRegistry, getVerifiedAssets, CuratedAsset } from "./verifiedAssets";

// Canonical definitions live in packages/types so web/mobile share them.
export type { AssetSearchPage, AssetSearchResult };

/** Loose shape of a Horizon asset record — only the fields read here. */
export interface HorizonAssetRecord {
  asset_type: string;
  asset_code: string;
  asset_issuer: string;
  paging_token: string;
  num_accounts?: number;
  accounts?: { authorized?: number };
  _links?: { toml?: { href?: string } };
}

export interface AssetSearchDeps {
  /** Horizon `/assets` page for `code`. */
  fetchAssetsPage: (params: { code: string; limit: number; cursor?: string }) => Promise<HorizonAssetRecord[]>;
  /** Horizon `/assets` for one exact CODE:ISSUER; null if Horizon has no record. */
  fetchAsset: (code: string, issuer: string) => Promise<HorizonAssetRecord | null>;
  verified: VerifiedAssetRegistry;
  metadata: Pick<AssetMetadataService, "listDomainCurrencies">;
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

// Thresholds for risk assessment
const LOW_HOLDER_THRESHOLD = 100; // Below this is "low_holders"
const VERY_NEW_THRESHOLD_DAYS = 30; // Assets newer than this are "very_new"

function horizonUnavailable(): HorizonError {
  return new HorizonError("Could not search assets on Horizon", {
    code: "HORIZON_UNAVAILABLE",
    retryable: true,
  });
}

function defaultDeps(): Omit<AssetSearchDeps, "metadata"> {
  const horizon = new StellarSdk.Horizon.Server(config.HORIZON_URL);
  return {
    fetchAssetsPage: async ({ code, limit, cursor }) => {
      try {
        let builder = horizon.assets().forCode(code).order("desc").limit(limit);
        if (cursor) builder = builder.cursor(cursor);
        const page = await builder.call();
        return page.records as unknown as HorizonAssetRecord[];
      } catch {
        throw horizonUnavailable();
      }
    },
    fetchAsset: async (code, issuer) => {
      try {
        const page = await horizon.assets().forCode(code).forIssuer(issuer).limit(1).call();
        return (page.records[0] as unknown as HorizonAssetRecord | undefined) ?? null;
      } catch {
        throw horizonUnavailable();
      }
    },
    verified: createVerifiedAssetRegistry(),
  };
}

function homeDomainFromToml(record: HorizonAssetRecord): string | null {
  const href = record._links?.toml?.href;
  if (!href) return null;
  try {
    return new URL(href).hostname || null;
  } catch {
    return null;
  }
}

function holderCount(record: HorizonAssetRecord): number {
  return record.accounts?.authorized ?? record.num_accounts ?? 0;
}

/**
 * Detect homoglyph domains: visually similar domains that could trick users.
 * Examples: "usdc-center.com" vs "usdc-center.io", "ce1rce.io" vs "centre.io".
 */
function hasHomoglyphDomain(
  domain: string,
  verifiedAssets: Set<{ code: string; domain: string }>,
): boolean {
  if (!domain) return false;
  const cleanDomain = domain.toLowerCase();

  for (const v of verifiedAssets) {
    if (v.domain.toLowerCase() === cleanDomain) continue; // Exact match is fine
    // Check for common homoglyph patterns
    const verifiedClean = v.domain.toLowerCase();
    if (areHomoglyphs(cleanDomain, verifiedClean)) return true;
  }
  return false;
}

/**
 * Simple homoglyph detection: compare character-by-character with common
 * confusing pairs (0/O, 1/I, l/i, etc.) and Levenshtein-like similarity.
 */
function areHomoglyphs(a: string, b: string): boolean {
  if (a === b) return false; // Exact match is not a homoglyph
  if (Math.abs(a.length - b.length) > 2) return false; // Too different in length

  const confusingPairs: Record<string, string> = {
    "0": "o", "o": "0",
    "1": "i", "i": "1", "l": "i",
    "c": "e", "e": "c",
    ".": "",
  };

  let edits = 0;
  let ai = 0, bi = 0;

  while (ai < a.length && bi < b.length) {
    const ca = a[ai].toLowerCase();
    const cb = b[bi].toLowerCase();

    if (ca === cb) {
      ai++; bi++;
      continue;
    }

    // Check for homoglyph substitution
    if (confusingPairs[ca] === cb || confusingPairs[cb] === ca) {
      edits++;
      ai++; bi++;
      if (edits > 1) return false;
      continue;
    }

    // Check for transposition (e.g., "ce1rce" vs "centre")
    if (ai + 1 < a.length && bi + 1 < b.length && ca === b[bi + 1] && cb === a[ai + 1]) {
      edits++;
      ai += 2; bi += 2;
      if (edits > 1) return false;
      continue;
    }

    edits++;
    if (edits > 1) return false;

    ai++; bi++;
  }

  edits += Math.abs((a.length - ai) - (b.length - bi));
  return edits <= 1;
}

/**
 * Check if there are multiple issuers for the same code (potential confusion).
 */
function hasSameCodeDifferentIssuer(
  code: string,
  issuer: string,
  allResults: Array<{ code: string; issuer: string; verified: boolean }>,
): boolean {
  const sameCode = allResults.filter((r) => r.code === code);
  if (sameCode.length <= 1) return false;

  const unverifiedWithSameCode = sameCode.filter((r) => !r.verified);
  return unverifiedWithSameCode.some((r) => r.issuer !== issuer);
}

/**
 * Calculate risk level and factors for an asset search result.
 */
function assessRisk(
  result: AssetSearchResult,
  allResults: AssetSearchResult[],
  verifiedAssets: Set<{ code: string; domain: string }>,
): { riskLevel: "low" | "medium" | "high" | "critical"; riskFactors: RiskFactor[] } {
  const factors: RiskFactor[] = [];
  let riskScore = 0;

  // Factor 1: Unverified assets
  if (!result.verified) {
    factors.push("unverified");
    riskScore += 2;
  }

  // Factor 2: Same code, different issuer (especially unverified)
  if (hasSameCodeDifferentIssuer(result.code, result.issuer, allResults)) {
    factors.push("same_code_different_issuer");
    riskScore += 2;
  }

  // Factor 3: Homoglyph domain (visually similar to verified issuer)
  if (hasHomoglyphDomain(result.homeDomain ?? "", verifiedAssets)) {
    factors.push("homoglyph_domain");
    riskScore += 3;
  }

  // Factor 4: Low holder count
  if (result.numAccounts !== null && result.numAccounts < LOW_HOLDER_THRESHOLD) {
    factors.push("low_holders");
    riskScore += 1;
  }

  // Factor 5: Very new asset (placeholder - would need creation ledger)
  // TODO: Implement age detection when Horizon provides creation ledger per asset
  // factors.push("very_new");

  // Factor 6: No home domain
  if (!result.homeDomain) {
    factors.push("unknown_domain");
    riskScore += 1;
  }

  // Determine risk level
  let riskLevel: "low" | "medium" | "high" | "critical";
  if (riskScore === 0) {
    riskLevel = "low";
  } else if (riskScore <= 2) {
    riskLevel = "medium";
  } else if (riskScore <= 4) {
    riskLevel = "high";
  } else {
    riskLevel = "critical";
  }

  // Verified assets with no issues are always "low"
  if (result.verified && factors.length === 0) {
    riskLevel = "low";
  }

  return { riskLevel, riskFactors: factors };
}

export class AssetSearchService {
  private readonly deps: AssetSearchDeps;
  private verifiedAssetsCache: Set<{ code: string; domain: string }> | null = null;

  constructor(deps: Partial<AssetSearchDeps> = {}) {
    const base = defaultDeps();
    this.deps = {
      ...base,
      metadata: deps.metadata ?? new AssetMetadataService(),
      ...deps,
    };
  }

  private getVerifiedAssetsSet(): Set<{ code: string; domain: string }> {
    if (!this.verifiedAssetsCache) {
      this.verifiedAssetsCache = new Set();
      for (const asset of this.deps.verified.verifiedAssets || getVerifiedAssets()) {
        this.verifiedAssetsCache.add({ code: asset.code, domain: asset.domain });
      }
    }
    return this.verifiedAssetsCache;
  }

  private toResult(record: HorizonAssetRecord, allResults: AssetSearchResult[] = []): AssetSearchResult {
    const base = {
      code: record.asset_code,
      issuer: record.asset_issuer,
      homeDomain: homeDomainFromToml(record),
      numAccounts: holderCount(record),
      verified: this.deps.verified.isVerified(record.asset_code, record.asset_issuer),
    };

    // Only compute risk if we have enough context
    if (allResults.length > 0) {
      const risk = assessRisk(base, allResults, this.getVerifiedAssetsSet());
      return { ...base, ...risk };
    }

    // Fallback for initial construction (e.g., fetching missing verified assets)
    return { ...base, riskLevel: "low", riskFactors: [] };
  }

  async searchByCode(params: { code: string; limit: number; cursor?: string }): Promise<AssetSearchPage> {
    const { code, limit, cursor } = params;
    const records = await this.deps.fetchAssetsPage({ code, limit, cursor });
    const results = records.map((r) => this.toResult(r));

    if (!cursor) {
      const present = new Set(results.map((r) => r.issuer));
      const missing = this.deps.verified.issuersForCode(code).filter((issuer) => !present.has(issuer));
      const extra = await Promise.all(missing.map((issuer) => this.deps.fetchAsset(code, issuer)));
      for (const record of extra) {
        if (record) results.push(this.toResult(record, results));
      }
    }

    // Re-assess risk with complete set
    const riskAssessed = results.map((r) => assessRisk(r, results, this.getVerifiedAssetsSet()));
    const finalResults = results.map((r, i) => ({ ...r, ...riskAssessed[i] }));

    // Horizon pages are cursor-based on its own ordering, so the cursor is
    // the last *Horizon* record's token, not the last item after re-ranking.
    const nextCursor = records.length === limit ? records[records.length - 1].paging_token : null;
    return { results: rankResults(finalResults), nextCursor };
  }

  async searchByDomain(domain: string): Promise<AssetSearchPage> {
    const currencies = await this.deps.metadata.listDomainCurrencies(domain);
    const homeDomain = domain.trim().toLowerCase();
    const results = currencies.map((c) => ({
      code: c.code,
      issuer: c.issuer,
      homeDomain,
      numAccounts: null,
      verified: this.deps.verified.isVerified(c.code, c.issuer),
      riskLevel: "low" as const,
      riskFactors: [] as RiskFactor[],
    }));

    // Re-assess risk with complete set
    const riskAssessed = results.map((r) => assessRisk(r, results, this.getVerifiedAssetsSet()));
    const finalResults = results.map((r, i) => ({ ...r, ...riskAssessed[i] }));

    return { results: rankResults(finalResults), nextCursor: null };
  }
}
}

/**
 * Verified first, then by risk level (low to high), then by holder count,
 * then code:issuer for stable ordering.
 */
export function rankResults(results: AssetSearchResult[]): AssetSearchResult[] {
  return [...results].sort((a, b) => {
    // Verified assets first
    if (a.verified !== b.verified) return a.verified ? -1 : 1;

    // Then by risk level (lower risk is better)
    const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    const riskDiff = riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
    if (riskDiff !== 0) return riskDiff;

    // Then by holder count (descending)
    const holders = (b.numAccounts ?? -1) - (a.numAccounts ?? -1);
    if (holders !== 0) return holders;

    // Finally by code:issuer for stable ordering
    return `${a.code}:${a.issuer}`.localeCompare(`${b.code}:${b.issuer}`);
  });
}
