import { randomUUID } from "crypto";
import { LockAcquisitionError } from "../stellarErrors";
import { metrics } from "../metrics";

/**
 * Mutual-exclusion primitive keyed by Stellar account public key.
 *
 * `sendPayment` must run at most one in-flight submission per source
 * account at a time. Both backends (`InProcessAccountLock`,
 * `RedisAccountLock`) share this base class and therefore the exact same
 * semantics (issue #197, docs/concurrency.md):
 *
 * - **Lease (TTL).** A holder owns the lock for `ttlMs`. While `withLock`'s
 *   callback runs the lease is extended every `renewIntervalMs`; a holder
 *   that dies stops renewing and its lease expires, so the next acquirer
 *   proceeds.
 * - **Fencing token.** Every successful acquisition gets a number strictly
 *   greater than any earlier one for the same account. Downstream writes can
 *   reject a stale holder whose lease expired mid-work.
 * - **Bounded wait.** Acquisition retries until `maxWaitMs`, then throws
 *   `LockAcquisitionError` (503, `LOCK_TIMEOUT`).
 * - **Not reentrant.** A nested `withLock` on the same account from inside
 *   the callback waits like any other caller and times out.
 * - **Release on error.** The lock is released whether the callback
 *   resolves or throws.
 * - **No strict fairness.** Waiters are not guaranteed FIFO order.
 */
export interface LockLease {
  readonly accountId: string;
  /** Monotonically increasing per account across all holders. */
  readonly fencingToken: number;
  /** Push the expiry out by another TTL. False when the lease was already lost. */
  extend(): Promise<boolean>;
  /** Release if still held. Never throws. */
  release(): Promise<void>;
}

export interface AccountLock {
  acquire(accountId: string): Promise<LockLease>;
  withLock<T>(accountId: string, fn: (lease: LockLease) => Promise<T>): Promise<T>;
}

export interface AccountLockOptions {
  /**
   * Lease length. Must exceed one renewal interval by a wide margin; the
   * default (45s) also covers a full submission if renewal stalls.
   */
  ttlMs?: number;
  /** Delay between acquisition attempts while the lock is held elsewhere. */
  retryDelayMs?: number;
  /** Give up and reject if the lock can't be acquired within this window. */
  maxWaitMs?: number;
  /** How often `withLock` extends the lease. Defaults to ttlMs / 3. */
  renewIntervalMs?: number;
}

export const DEFAULT_LOCK_OPTIONS = {
  ttlMs: 45_000,
  retryDelayMs: 100,
  maxWaitMs: 30_000,
} as const;

/** Shared acquisition loop, lease renewal and metrics. Backends supply the three primitives. */
export abstract class BaseAccountLock implements AccountLock {
  protected abstract readonly backend: string;
  protected readonly ttlMs: number;
  protected readonly retryDelayMs: number;
  protected readonly maxWaitMs: number;
  protected readonly renewIntervalMs: number;

  constructor(options: AccountLockOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LOCK_OPTIONS.ttlMs;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_OPTIONS.retryDelayMs;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_LOCK_OPTIONS.maxWaitMs;
    this.renewIntervalMs = options.renewIntervalMs ?? Math.max(1, Math.floor(this.ttlMs / 3));
  }

  /** Take the lock if free (or expired). Returns the fencing token, or null when held. */
  protected abstract tryAcquire(accountId: string, token: string): Promise<number | null>;
  /** Extend only if `token` still holds the lock. */
  protected abstract tryExtend(accountId: string, token: string): Promise<boolean>;
  /** Release only if `token` still holds the lock. */
  protected abstract tryRelease(accountId: string, token: string): Promise<void>;

  /** Wait before the next attempt. Backends may wake early on release. */
  protected waitForTurn(_accountId: string, ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async acquire(accountId: string): Promise<LockLease> {
    const token = randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + this.maxWaitMs;
    let contended = false;

    for (;;) {
      const fencingToken = await this.tryAcquire(accountId, token);
      if (fencingToken !== null) {
        metrics.lockWaitMs.observe(Date.now() - startedAt, { backend: this.backend });
        if (contended) metrics.lockContended.inc({ backend: this.backend });
        return this.lease(accountId, token, fencingToken);
      }
      contended = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        metrics.lockFailures.inc({ backend: this.backend, reason: "timeout" });
        throw new LockAcquisitionError(
          `Timed out after ${this.maxWaitMs}ms waiting for the submission lock ` +
            `on account ${accountId}. Another request may be mid-submission, ` +
            `or holding a stuck lock. The payment was NOT submitted — safe to retry.`
        );
      }
      await this.waitForTurn(accountId, Math.min(this.retryDelayMs, remaining));
    }
  }

  async withLock<T>(accountId: string, fn: (lease: LockLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(accountId);
    const timer = setInterval(() => {
      void lease.extend();
    }, this.renewIntervalMs);
    timer.unref?.();
    try {
      return await fn(lease);
    } finally {
      clearInterval(timer);
      await lease.release();
    }
  }

  private lease(accountId: string, token: string, fencingToken: number): LockLease {
    let released = false;
    return {
      accountId,
      fencingToken,
      extend: async () => {
        if (released) return false;
        const ok = await this.tryExtend(accountId, token).catch(() => false);
        if (!ok) metrics.lockLeaseLost.inc({ backend: this.backend });
        return ok;
      },
      release: async () => {
        if (released) return;
        released = true;
        // Best effort: if this fails the TTL still frees the lock.
        await this.tryRelease(accountId, token).catch(() => {});
      },
    };
  }
}

/**
 * Single-process backend: the same lease/fencing semantics as Redis, kept
 * in a Map. Correct within one Node process only — each process has its own
 * map, so more than one API instance needs `RedisAccountLock`.
 */
/** Lock table for `InProcessAccountLock`. Instances that share one contend with each other. */
export class InProcessLockState {
  readonly holders = new Map<string, { token: string; expiresAt: number }>();
  readonly fences = new Map<string, number>();
  readonly waiters = new Map<string, Set<() => void>>();
}

export class InProcessAccountLock extends BaseAccountLock {
  protected readonly backend = "in-process";
  private readonly holders: InProcessLockState["holders"];
  private readonly fences: InProcessLockState["fences"];
  private readonly waiters: InProcessLockState["waiters"];

  constructor(options: AccountLockOptions = {}, state: InProcessLockState = new InProcessLockState()) {
    super(options);
    this.holders = state.holders;
    this.fences = state.fences;
    this.waiters = state.waiters;
  }

  protected async tryAcquire(accountId: string, token: string): Promise<number | null> {
    const now = Date.now();
    const holder = this.holders.get(accountId);
    if (holder && holder.expiresAt > now) return null;
    this.holders.set(accountId, { token, expiresAt: now + this.ttlMs });
    const fence = (this.fences.get(accountId) ?? 0) + 1;
    this.fences.set(accountId, fence);
    return fence;
  }

  protected async tryExtend(accountId: string, token: string): Promise<boolean> {
    const now = Date.now();
    const holder = this.holders.get(accountId);
    if (!holder || holder.token !== token || holder.expiresAt <= now) return false;
    holder.expiresAt = now + this.ttlMs;
    return true;
  }

  protected async tryRelease(accountId: string, token: string): Promise<void> {
    const holder = this.holders.get(accountId);
    if (!holder || holder.token !== token) return;
    this.holders.delete(accountId);
    // Wake waiters in arrival order; the first to resume takes the lock.
    const waiting = this.waiters.get(accountId);
    if (waiting) [...waiting].forEach((wake) => wake());
  }

  protected waitForTurn(accountId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(accountId);
      if (!set) {
        set = new Set();
        this.waiters.set(accountId, set);
      }
      const wake = () => {
        clearTimeout(timer);
        set!.delete(wake);
        if (set!.size === 0 && this.waiters.get(accountId) === set) this.waiters.delete(accountId);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      set.add(wake);
    });
  }
}
