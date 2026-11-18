import { randomUUID } from "crypto";
import { AccountLock, AccountLockOptions } from "../../src/services/locks/accountLock";
import { LockAcquisitionError } from "../../src/services/stellarErrors";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared behavioural contract for every AccountLock backend (#197). Each
 * backend's test file calls this with a factory, so the in-process and
 * Redis implementations are held to exactly the same semantics.
 *
 * `makeLock` may be called several times in one test: each call stands for
 * a separate API instance sharing the same backend.
 */
export function describeAccountLockContract(
  name: string,
  makeLock: (options: AccountLockOptions) => AccountLock
): void {
  const account = () => `contract-${randomUUID()}`;

  describe(`${name} — AccountLock contract`, () => {
    it("never interleaves two holders of the same account", async () => {
      const a = makeLock({ retryDelayMs: 5, maxWaitMs: 5000 });
      const b = makeLock({ retryDelayMs: 5, maxWaitMs: 5000 });
      const id = account();
      const events: string[] = [];
      const task = (lock: AccountLock, label: string) =>
        lock.withLock(id, async () => {
          events.push(`${label}:start`);
          await sleep(30);
          events.push(`${label}:end`);
          return label;
        });

      const results = await Promise.all([task(a, "a"), task(b, "b"), task(a, "c")]);

      expect(results.sort()).toEqual(["a", "b", "c"]);
      for (let i = 0; i < events.length; i += 2) {
        const label = events[i].split(":")[0];
        expect(events[i + 1]).toBe(`${label}:end`);
      }
    }, 10000);

    it("does not serialize different accounts", async () => {
      const lock = makeLock({ retryDelayMs: 5, maxWaitMs: 5000 });
      const events: string[] = [];
      await Promise.all([
        lock.withLock(account(), async () => {
          events.push("slow:start");
          await sleep(60);
          events.push("slow:end");
        }),
        lock.withLock(account(), async () => {
          events.push("fast:start");
          await sleep(5);
          events.push("fast:end");
        }),
      ]);
      expect(events.indexOf("fast:start")).toBeLessThan(events.indexOf("slow:end"));
    });

    it("releases the lock when the callback throws", async () => {
      const lock = makeLock({ retryDelayMs: 5, maxWaitMs: 200 });
      const id = account();
      await expect(
        lock.withLock(id, async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      await expect(lock.withLock(id, async () => "recovered")).resolves.toBe("recovered");
    });

    it("hands out strictly increasing fencing tokens per account", async () => {
      const a = makeLock({ retryDelayMs: 5, maxWaitMs: 2000 });
      const b = makeLock({ retryDelayMs: 5, maxWaitMs: 2000 });
      const id = account();
      const tokens: number[] = [];
      for (const lock of [a, b, a, b]) {
        await lock.withLock(id, async (lease) => {
          tokens.push(lease.fencingToken);
        });
      }
      for (let i = 1; i < tokens.length; i++) {
        expect(tokens[i]).toBeGreaterThan(tokens[i - 1]);
      }
    });

    it("throws LockAcquisitionError after maxWaitMs while another holder keeps the lock", async () => {
      const holder = makeLock({ retryDelayMs: 5, maxWaitMs: 2000 });
      const waiter = makeLock({ retryDelayMs: 5, maxWaitMs: 80 });
      const id = account();
      let release!: () => void;
      const held = holder.withLock(id, () => new Promise<void>((resolve) => (release = resolve)));
      await sleep(20);

      await expect(waiter.withLock(id, async () => "never")).rejects.toBeInstanceOf(LockAcquisitionError);

      release();
      await held;
    });

    it("is not reentrant: a nested acquire of the same account times out", async () => {
      const lock = makeLock({ retryDelayMs: 5, maxWaitMs: 80 });
      const id = account();
      await expect(
        lock.withLock(id, () => lock.withLock(id, async () => "nested"))
      ).rejects.toBeInstanceOf(LockAcquisitionError);
      // And the outer lock was released despite the nested failure.
      await expect(lock.withLock(id, async () => "after")).resolves.toBe("after");
    });

    it("lets the next acquirer proceed once a killed holder's lease expires", async () => {
      const crashed = makeLock({ ttlMs: 100, retryDelayMs: 10, maxWaitMs: 2000 });
      const next = makeLock({ ttlMs: 100, retryDelayMs: 10, maxWaitMs: 2000 });
      const id = account();

      // A holder that dies: acquires, never renews, never releases.
      const dead = await crashed.acquire(id);
      const startedAt = Date.now();
      const lease = await next.acquire(id);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
      expect(lease.fencingToken).toBeGreaterThan(dead.fencingToken);
      // The dead holder can't resurrect its lease or free the new one.
      await expect(dead.extend()).resolves.toBe(false);
      await dead.release();
      const third = makeLock({ retryDelayMs: 5, maxWaitMs: 40 });
      await expect(third.acquire(id)).rejects.toBeInstanceOf(LockAcquisitionError);
      await lease.release();
    }, 10000);

    it("keeps a live holder's lease alive past the TTL by renewing it", async () => {
      const holder = makeLock({ ttlMs: 80, renewIntervalMs: 20, retryDelayMs: 5, maxWaitMs: 2000 });
      const competitor = makeLock({ ttlMs: 80, retryDelayMs: 5, maxWaitMs: 2000 });
      const id = account();
      const events: string[] = [];

      const long = holder.withLock(id, async () => {
        events.push("holder:start");
        await sleep(250);
        events.push("holder:end");
      });
      await sleep(10);
      await competitor.withLock(id, async () => {
        events.push("competitor:start");
      });
      await long;

      expect(events).toEqual(["holder:start", "holder:end", "competitor:start"]);
    }, 10000);
  });
}
