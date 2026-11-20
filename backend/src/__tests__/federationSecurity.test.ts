import {
  FederationService,
  validateFederationMemo,
  isSsrfSafeDomain,
  InvalidFederationResponseError,
  InvalidAddressError,
} from "../services/federation";

describe("Federation Security & Validation (#217)", () => {
  it("rejects SSRF forbidden hostnames and IP addresses", () => {
    expect(isSsrfSafeDomain("localhost")).toBe(false);
    expect(isSsrfSafeDomain("127.0.0.1")).toBe(false);
    expect(isSsrfSafeDomain("169.254.169.254")).toBe(false);
    expect(isSsrfSafeDomain("internal.lan")).toBe(false);
    expect(isSsrfSafeDomain("corp.local")).toBe(false);
    expect(isSsrfSafeDomain("stellar.org")).toBe(true);
    expect(isSsrfSafeDomain("example.com")).toBe(true);
  });

  it("validates memo formats strictly against memo_type", () => {
    // Valid text
    expect(validateFederationMemo("hello", "text")).toEqual({ memo: "hello", memoType: "text" });

    // Valid id
    expect(validateFederationMemo("123456", "id")).toEqual({ memo: "123456", memoType: "id" });

    // Valid hash (64 hex characters)
    const validHash = "a".repeat(64);
    expect(validateFederationMemo(validHash, "hash")).toEqual({ memo: validHash, memoType: "hash" });

    // Invalid id (non-numeric)
    expect(() => validateFederationMemo("notanid", "id")).toThrow();

    // Invalid text (too long > 28 bytes)
    expect(() => validateFederationMemo("a".repeat(29), "text")).toThrow();

    // Invalid hash
    expect(() => validateFederationMemo("short_hash", "hash")).toThrow();
  });

  it("rejects federation responses with malformed account IDs", async () => {
    const mockResolver = async () => ({
      account_id: "MALFORMED_NOT_A_STELLAR_ADDRESS",
    });

    const federation = new FederationService(mockResolver);

    await expect(federation.resolveAddress("alice*example.com")).rejects.toThrow(
      InvalidFederationResponseError
    );
  });

  it("returns query and resolved details on success", async () => {
    const mockResolver = async () => ({
      account_id: "GBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K",
      memo_type: "text",
      memo: "donation",
    });

    const federation = new FederationService(mockResolver);
    const result = await federation.resolveAddress("alice*example.com");

    expect(result.query).toBe("alice*example.com");
    expect(result.type).toBe("federation");
    expect(result.accountId).toBe("GBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K");
    expect(result.memo).toBe("donation");
  });
});
