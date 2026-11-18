import { createClient, RedisClientType } from "redis";
import { RedisAccountLock } from "../../src/services/locks/redisAccountLock";
import { LockUnavailableError } from "../../src/services/stellarErrors";
import { describeAccountLockContract } from "./accountLockContract";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6379";

// Runs against a real local Redis (redis-server on localhost:6379): this is
// the backend that closes the multi-instance gap (docs/concurrency.md), so
// the shared contract is exercised for real rather than mocked. Two
// connections stand in for two API instances.
describe("RedisAccountLock (real Redis)", () => {
  const clients: RedisClientType[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const client = createClient({ url: REDIS_URL }) as RedisClientType;
      await client.connect();
      clients.push(client);
    }
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  let next = 0;
  describeAccountLockContract("RedisAccountLock", (options) => new RedisAccountLock(clients[next++ % 2], options));
});

describe("RedisAccountLock fails closed", () => {
  it("throws LOCK_UNAVAILABLE without running the callback when Redis errors", async () => {
    const client = {
      isReady: true,
      eval: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as unknown as RedisClientType;
    const fn = jest.fn();

    const err = await new RedisAccountLock(client).withLock("acct", fn).catch((e) => e);

    expect(err).toBeInstanceOf(LockUnavailableError);
    expect(err.code).toBe("LOCK_UNAVAILABLE");
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws LOCK_UNAVAILABLE when the client is disconnected", async () => {
    const client = { isReady: false, eval: jest.fn() } as unknown as RedisClientType;

    await expect(new RedisAccountLock(client).withLock("acct", jest.fn())).rejects.toBeInstanceOf(LockUnavailableError);
    expect((client as unknown as { eval: jest.Mock }).eval).not.toHaveBeenCalled();
  });
});
