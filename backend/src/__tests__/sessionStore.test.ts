import { SessionStore } from "../services/sessionStore";
import { UnauthorizedError } from "../errors/appError";

describe("SessionStore & Revocation (#200)", () => {
  let sessionStore: SessionStore;
  const mockStorage = new Map<string, string>();
  const mockSets = new Map<string, Set<string>>();

  beforeEach(() => {
    mockStorage.clear();
    mockSets.clear();
    sessionStore = new SessionStore("redis://localhost:6379");

    // Mock Redis client methods on sessionStore
    // @ts-expect-error mocking internal client
    sessionStore.getClient = async () => ({
      get: async (k: string) => mockStorage.get(k) ?? null,
      set: async (k: string, v: string) => {
        mockStorage.set(k, v);
        return "OK";
      },
      del: async (k: string) => {
        mockStorage.delete(k);
        return 1;
      },
      sAdd: async (k: string, v: string) => {
        if (!mockSets.has(k)) mockSets.set(k, new Set());
        mockSets.get(k)!.add(v);
        return 1;
      },
      sRem: async (k: string, v: string) => {
        mockSets.get(k)?.delete(v);
        return 1;
      },
      sMembers: async (k: string) => Array.from(mockSets.get(k) ?? []),
      isOpen: true,
    });
  });

  it("creates and retrieves a session with device info", async () => {
    const session = await sessionStore.createSession({
      sub: "GBEXAMPLEACCOUNT",
      deviceId: "dev_123",
      deviceLabel: "iPhone 15",
      userAgent: "GlobeWallet-iOS/1.0",
    });

    expect(session.id).toBeDefined();
    expect(session.sub).toBe("GBEXAMPLEACCOUNT");
    expect(session.deviceId).toBe("dev_123");

    const fetched = await sessionStore.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.deviceLabel).toBe("iPhone 15");
  });

  it("detects refresh token reuse and revokes the compromised session", async () => {
    const session = await sessionStore.createSession({ sub: "GBEXAMPLE" });
    const token = "refresh_token_abc";
    await sessionStore.storeRefreshToken(token, session.id, "GBEXAMPLE");

    // First rotation succeeds
    const rotated = await sessionStore.rotateRefreshToken(token);
    expect(rotated.newToken).toBeDefined();

    // Replay attempt with the old token MUST throw TOKEN_REUSE_DETECTED
    await expect(sessionStore.rotateRefreshToken(token)).rejects.toThrow(UnauthorizedError);

    // Verify session was revoked
    const isRevoked = await sessionStore.isSessionRevoked("GBEXAMPLE", session.id);
    expect(isRevoked).toBe(true);
  });

  it("revokes all sessions on account security reset", async () => {
    const s1 = await sessionStore.createSession({ sub: "GBUSER" });
    const s2 = await sessionStore.createSession({ sub: "GBUSER" });

    const revokedCount = await sessionStore.revokeAllSessions("GBUSER");
    expect(revokedCount).toBe(2);

    expect(await sessionStore.isSessionRevoked("GBUSER", s1.id)).toBe(true);
    expect(await sessionStore.isSessionRevoked("GBUSER", s2.id)).toBe(true);
  });
});
