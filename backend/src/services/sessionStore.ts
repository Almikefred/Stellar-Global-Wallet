import { createClient, RedisClientType } from "redis";
import { config } from "../config";
import { AppError, UnauthorizedError } from "../errors/appError";
import crypto from "node:crypto";

export interface SessionRecord {
  id: string;
  sub: string;
  deviceId?: string;
  deviceLabel?: string;
  userAgent?: string;
  ipHash?: string;
  authMethod?: string;
  createdAt: string;
  lastUsedAt: string;
  revoked?: boolean;
  revokedAt?: string;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  sessionId: string;
  sub: string;
  familyId: string;
  used: boolean;
  createdAt: string;
  expiresAt: number;
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const REVOCATION_CACHE_TTL_MS = 1000; // 1-second in-memory cache

export class SessionStore {
  private client?: RedisClientType;
  private revocationCache = new Map<string, { revoked: boolean; cachedAt: number }>();

  constructor(private readonly redisUrl: string = config.REDIS_URL) {}

  private async getClient(): Promise<RedisClientType> {
    if (!this.client) {
      this.client = createClient({ url: this.redisUrl }) as RedisClientType;
      this.client.on("error", (err: Error) => {
        console.error("[session-store] Redis error:", err.message);
      });
    }
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    return this.client;
  }

  private sessionKey(sessionId: string): string {
    return `orbit-wal:session:${sessionId}`;
  }

  private accountSessionsKey(sub: string): string {
    return `orbit-wal:account-sessions:${sub}`;
  }

  private refreshTokenKey(tokenHash: string): string {
    return `orbit-wal:refresh-token:${tokenHash}`;
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Creates a new session record tied to an account and optional device.
   */
  async createSession(params: {
    sub: string;
    deviceId?: string;
    deviceLabel?: string;
    userAgent?: string;
    ipHash?: string;
    authMethod?: string;
  }): Promise<SessionRecord> {
    const client = await this.getClient();
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const record: SessionRecord = {
      id: sessionId,
      sub: params.sub,
      deviceId: params.deviceId,
      deviceLabel: params.deviceLabel,
      userAgent: params.userAgent,
      ipHash: params.ipHash,
      authMethod: params.authMethod,
      createdAt: now,
      lastUsedAt: now,
      revoked: false,
    };

    await client.set(this.sessionKey(sessionId), JSON.stringify(record), {
      EX: SESSION_TTL_SECONDS,
    });
    await client.sAdd(this.accountSessionsKey(params.sub), sessionId);

    this.revocationCache.set(sessionId, { revoked: false, cachedAt: Date.now() });
    return record;
  }

  /**
   * Retrieves a session by ID.
   */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const client = await this.getClient();
    const raw = await client.get(this.sessionKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionRecord;
  }

  /**
   * Checks whether a session has been revoked.
   * Uses a fast 1-second in-memory cache to satisfy the requirement:
   * "Revocation checked on every request; revoked session rejected on all instances within 1s."
   */
  async isSessionRevoked(sub: string, sessionId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.revocationCache.get(sessionId);
    if (cached && now - cached.cachedAt < REVOCATION_CACHE_TTL_MS) {
      return cached.revoked;
    }

    const session = await this.getSession(sessionId);
    const revoked = !session || session.revoked === true || session.sub !== sub;
    this.revocationCache.set(sessionId, { revoked, cachedAt: now });
    return revoked;
  }

  /**
   * Revokes a single session.
   */
  async revokeSession(sub: string, sessionId: string): Promise<boolean> {
    const client = await this.getClient();
    const session = await this.getSession(sessionId);
    if (!session || session.sub !== sub) {
      return false;
    }

    session.revoked = true;
    session.revokedAt = new Date().toISOString();

    await client.set(this.sessionKey(sessionId), JSON.stringify(session), {
      EX: 86400, // Retain revoked tombstone for 24 hours
    });
    await client.sRem(this.accountSessionsKey(sub), sessionId);

    this.revocationCache.set(sessionId, { revoked: true, cachedAt: Date.now() });
    return true;
  }

  /**
   * Revokes every session for an account (e.g. on key rotation or account recovery).
   * Optionally keeps the caller's current session alive.
   */
  async revokeAllSessions(sub: string, keepSessionId?: string): Promise<number> {
    const client = await this.getClient();
    const sessionIds = await client.sMembers(this.accountSessionsKey(sub));
    let count = 0;

    for (const id of sessionIds) {
      if (keepSessionId && id === keepSessionId) continue;
      await this.revokeSession(sub, id);
      count++;
    }

    if (!keepSessionId) {
      await client.del(this.accountSessionsKey(sub));
    }

    return count;
  }

  /**
   * Lists all active sessions for an account.
   */
  async listSessions(sub: string): Promise<SessionRecord[]> {
    const client = await this.getClient();
    const sessionIds = await client.sMembers(this.accountSessionsKey(sub));
    const active: SessionRecord[] = [];

    for (const id of sessionIds) {
      const session = await this.getSession(id);
      if (session && !session.revoked) {
        active.push(session);
      } else {
        await client.sRem(this.accountSessionsKey(sub), id);
      }
    }

    return active.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /**
   * Registers a new refresh token family for a session.
   */
  async storeRefreshToken(token: string, sessionId: string, sub: string, familyId?: string): Promise<void> {
    const client = await this.getClient();
    const tokenHash = this.hashToken(token);
    const fam = familyId ?? crypto.randomUUID();

    const record: RefreshTokenRecord = {
      tokenHash,
      sessionId,
      sub,
      familyId: fam,
      used: false,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };

    await client.set(this.refreshTokenKey(tokenHash), JSON.stringify(record), {
      EX: SESSION_TTL_SECONDS,
    });
  }

  /**
   * Rotates a refresh token with strict reuse detection.
   * If a previously rotated token is used again, the entire session family is compromised:
   * all tokens in that family are revoked immediately.
   */
  async rotateRefreshToken(
    oldToken: string,
    metadata: { userAgent?: string; ipHash?: string } = {}
  ): Promise<{ newToken: string; sessionId: string; sub: string }> {
    const client = await this.getClient();
    const oldHash = this.hashToken(oldToken);
    const raw = await client.get(this.refreshTokenKey(oldHash));

    if (!raw) {
      throw new UnauthorizedError("Refresh token is invalid or expired", "TOKEN_INVALID");
    }

    const oldRecord = JSON.parse(raw) as RefreshTokenRecord;

    // Reuse detection (#200): If already marked used, this is a replay attack!
    if (oldRecord.used) {
      console.warn(`[session-store] Refresh token reuse detected for sub ${oldRecord.sub}! Revoking session.`);
      await this.revokeSession(oldRecord.sub, oldRecord.sessionId);
      throw new UnauthorizedError("Refresh token reuse detected. Session has been revoked.", "TOKEN_REUSE_DETECTED");
    }

    // Check if session is revoked
    if (await this.isSessionRevoked(oldRecord.sub, oldRecord.sessionId)) {
      throw new UnauthorizedError("Session has been revoked", "SESSION_REVOKED");
    }

    // Mark old token as used
    oldRecord.used = true;
    await client.set(this.refreshTokenKey(oldHash), JSON.stringify(oldRecord), {
      EX: 86400, // keep used record for 24h for reuse detection
    });

    // Create new token in the same family
    const newToken = crypto.randomBytes(32).toString("hex");
    await this.storeRefreshToken(newToken, oldRecord.sessionId, oldRecord.sub, oldRecord.familyId);

    // Update session lastUsedAt
    const session = await this.getSession(oldRecord.sessionId);
    if (session) {
      session.lastUsedAt = new Date().toISOString();
      if (metadata.userAgent) session.userAgent = metadata.userAgent;
      if (metadata.ipHash) session.ipHash = metadata.ipHash;
      await client.set(this.sessionKey(oldRecord.sessionId), JSON.stringify(session), {
        EX: SESSION_TTL_SECONDS,
      });
    }

    return {
      newToken,
      sessionId: oldRecord.sessionId,
      sub: oldRecord.sub,
    };
  }

  /** Reset in-memory cache for tests. */
  resetCache(): void {
    this.revocationCache.clear();
  }
}

export const sessionStore = new SessionStore();
export const revokeAllSessions = (sub: string) => sessionStore.revokeAllSessions(sub);
