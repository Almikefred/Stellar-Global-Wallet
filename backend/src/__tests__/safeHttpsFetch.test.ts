import { safeHttpsGetText, SafeFetchError, isValidPublicHostname, isBlockedAddress } from "../services/safeHttpsFetch";

const TIMEOUT_MS = 5000;
const MAX_BYTES = 100 * 1024;

describe("isValidPublicHostname", () => {
  test("accepts valid public hostnames", () => {
    expect(isValidPublicHostname("example.com")).toBe(true);
    expect(isValidPublicHostname("sub.example.com")).toBe(true);
    expect(isValidPublicHostname("stellar.org")).toBe(true);
    expect(isValidPublicHostname("api.github.com")).toBe(true);
  });

  test("rejects IP addresses (dotted-quad)", () => {
    expect(isValidPublicHostname("127.0.0.1")).toBe(false);
    expect(isValidPublicHostname("8.8.8.8")).toBe(false);
    expect(isValidPublicHostname("10.0.0.1")).toBe(false);
    expect(isValidPublicHostname("255.255.255.255")).toBe(false);
  });

  test("rejects octal IP literals", () => {
    expect(isValidPublicHostname("0177.0.0.1")).toBe(false);
    expect(isValidPublicHostname("010.0.0.1")).toBe(false);
  });

  test("rejects hex IP literals", () => {
    expect(isValidPublicHostname("0x7f000001")).toBe(false);
    expect(isValidPublicHostname("0x00000000")).toBe(false);
    expect(isValidPublicHostname("0x0100007f")).toBe(false);
  });

  test("rejects decimal IP literals", () => {
    expect(isValidPublicHostname("2130706433")).toBe(false); // 127.0.0.1
    expect(isValidPublicHostname("3232235521")).toBe(false); // 192.168.1.1
    expect(isValidPublicHostname("167772161")).toBe(false); // 10.0.0.1
  });

  test("rejects IPv6 literals", () => {
    expect(isValidPublicHostname("::1")).toBe(false);
    expect(isValidPublicHostname("2001:4860:4860::8888")).toBe(false);
    expect(isValidPublicHostname("[::1]")).toBe(false);
  });

  test("rejects non-DNS strings", () => {
    expect(isValidPublicHostname("")).toBe(false);
    expect(isValidPublicHostname("justastring")).toBe(false);
    expect(isValidPublicHostname("123")).toBe(false);
    expect(isValidPublicHostname("example.com:8080")).toBe(false);
    expect(isValidPublicHostname("http://example.com")).toBe(false);
  });
});

describe("isBlockedAddress", () => {
  test("blocks IPv4 private ranges", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.255.255.255")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  test("blocks IPv4 loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.255.255.255")).toBe(true);
  });

  test("blocks IPv4 link-local / cloud metadata", () => {
    expect(isBlockedAddress("169.254.0.1")).toBe(true);
    expect(isBlockedAddress("169.254.255.255")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true); // AWS metadata
  });

  test("blocks IPv4 CGNAT", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("100.127.255.255")).toBe(true);
  });

  test("blocks IPv4 multicast", () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
    expect(isBlockedAddress("239.255.255.255")).toBe(true);
  });

  test("blocks IPv4 reserved ranges", () => {
    expect(isBlockedAddress("0.0.0.1")).toBe(true);
    expect(isBlockedAddress("240.0.0.1")).toBe(true);
    expect(isBlockedAddress("255.255.255.255")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedAddress("::")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  test("blocks IPv6 unique local addresses", () => {
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  test("blocks IPv6 link-local addresses", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  test("blocks IPv6 multicast", () => {
    expect(isBlockedAddress("ff02::1")).toBe(true);
    expect(isBlockedAddress("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  test("blocks NAT64 addresses", () => {
    expect(isBlockedAddress("64:ff9b::1")).toBe(true);
  });

  test("blocks documentation addresses", () => {
    expect(isBlockedAddress("2001:db8::1")).toBe(true);
  });

  test("accepts public IPv4", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("203.0.113.1")).toBe(false);
  });

  test("accepts public IPv6", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("safeHttpsGetText", () => {
  test("blocks loopback addresses", async () => {
    await expect(
      safeHttpsGetText("https://127.0.0.1/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["127.0.0.1"],
      })
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });

  test("blocks private IPv4 ranges", async () => {
    await expect(
      safeHttpsGetText("https://10.0.0.1/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["10.0.0.1"],
      })
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });

  test("blocks cloud metadata IP (169.254.169.254)", async () => {
    await expect(
      safeHttpsGetText("https://169.254.169.254/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["169.254.169.254"],
      })
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });

  test("blocks octal IP literals", async () => {
    await expect(
      safeHttpsGetText("https://0177.0.0.1/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("blocks hex IP literals", async () => {
    await expect(
      safeHttpsGetText("https://0x7f000001/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("blocks decimal IP literals", async () => {
    await expect(
      safeHttpsGetText("https://2130706433/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("blocks IPv4-mapped IPv6 addresses", async () => {
    await expect(
      safeHttpsGetText("https://[::ffff:127.0.0.1]/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("blocks link-local IPv6", async () => {
    await expect(
      safeHttpsGetText("https://[fe80::1]/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("blocks unique local IPv6", async () => {
    await expect(
      safeHttpsGetText("https://[fc00::1]/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("rejects non-https URLs", async () => {
    await expect(
      safeHttpsGetText("http://example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("rejects URLs with credentials", async () => {
    await expect(
      safeHttpsGetText("https://user:pass@example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("rejects URLs with non-default ports", async () => {
    await expect(
      safeHttpsGetText("https://example.com:8080/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("rejects non-FQDN hostnames", async () => {
    await expect(
      safeHttpsGetText("https://localhost/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("INVALID_URL");
  });

  test("detects DNS failures", async () => {
    await expect(
      safeHttpsGetText("https://nonexistent.invalid./", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("DNS_FAILURE");
  });

  test("times out on slow responses", async () => {
    await expect(
      safeHttpsGetText("https://example.com/slow", {
        timeoutMs: 500,
        maxBytes: MAX_BYTES,
      })
    ).rejects.toThrow("TIMEOUT");
  }, 2000);

  test("enforces response size limit", async () => {
    await expect(
      safeHttpsGetText("https://example.com/large", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: 1000,
      })
    ).rejects.toThrow("TOO_LARGE");
  });

  test("follows redirects within limit", async () => {
    const fetchPromise = safeHttpsGetText("https://example.com/", {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      resolve: async () => ["93.184.216.34"], // example.com IP
    });
    
    await expect(fetchPromise).rejects.toThrow("Upstream responded");
  }, 6000);

  test("blocks too many redirects", async () => {
    await expect(
      safeHttpsGetText("https://example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["93.184.216.34"],
      })
    ).resolves.not.toThrow();
  });
});

describe("DNS rebinding protection", () => {
  test("blocks mix of public and private records", async () => {
    await expect(
      safeHttpsGetText("https://example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["93.184.216.34", "127.0.0.1"], // public + loopback
      })
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });

  test("blocks mix with cloud metadata", async () => {
    await expect(
      safeHttpsGetText("https://example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => ["93.184.216.34", "169.254.169.254"],
      })
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });
});

describe("edge cases", () => {
  test("accepts valid subdomain with hyphen", () => {
    expect(isValidPublicHostname("api-test.example.com")).toBe(true);
  });

  test("rejects hostname starting with hyphen", () => {
    expect(isValidPublicHostname("-example.com")).toBe(false);
  });

  test("rejects hostname ending with hyphen", () => {
    expect(isValidPublicHostname("example-.com")).toBe(false);
  });

  test("rejects hostname with leading/trailing dots", () => {
    expect(isValidPublicHostname(".example.com")).toBe(false);
    expect(isValidPublicHostname("example.com.")).toBe(false);
  });

  test("blocks empty resolve result", async () => {
    await expect(
      safeHttpsGetText("https://example.com/", {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        resolve: async () => [],
      })
    ).rejects.toThrow("DNS_FAILURE");
  });
});
