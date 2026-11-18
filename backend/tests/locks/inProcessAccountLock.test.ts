import { InProcessAccountLock, InProcessLockState } from "../../src/services/locks/accountLock";
import { describeAccountLockContract, sleep } from "./accountLockContract";

// One lock table stands in for "the backend"; each factory call is another
// caller sharing it, exactly like separate RedisAccountLock instances
// sharing one Redis.
const state = new InProcessLockState();
describeAccountLockContract("InProcessAccountLock", (options) => new InProcessAccountLock(options, state));

describe("InProcessAccountLock specifics", () => {
  it("wakes waiters on release instead of waiting a full retry delay", async () => {
    const lock = new InProcessAccountLock({ retryDelayMs: 1000, maxWaitMs: 5000 });
    const startedAt = Date.now();
    await Promise.all([lock.withLock("acct", () => sleep(20)), lock.withLock("acct", async () => undefined)]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("separate lock tables do not see each other (one process each)", async () => {
    const a = new InProcessAccountLock({ maxWaitMs: 50 });
    const b = new InProcessAccountLock({ maxWaitMs: 50 });
    const lease = await a.acquire("acct");
    await expect(b.withLock("acct", async () => "ran")).resolves.toBe("ran");
    await lease.release();
  });
});
