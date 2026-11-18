import { createClient, RedisClientType } from "redis";
import { config } from "../../config";
import { AccountLock, InProcessAccountLock } from "./accountLock";
import { RedisAccountLock } from "./redisAccountLock";

export interface AccountLockHandle {
  lock: AccountLock;
  /** Releases any underlying connection (e.g. Redis) on shutdown. */
  shutdown: () => Promise<void>;
}

/**
 * Builds the AccountLock the running process should use, based on
 * LOCK_BACKEND. Only connects to Redis when actually configured to use it,
 * so single-instance/dev setups never need a Redis instance running.
 */
export async function createAccountLock(): Promise<AccountLockHandle> {
  if (config.LOCK_BACKEND === "redis") {
    // disableOfflineQueue: while Redis is down, commands fail at once instead
    // of queueing, so RedisAccountLock fails closed with LOCK_UNAVAILABLE
    // rather than holding the request until maxWaitMs (#197).
    const client = createClient({ url: config.REDIS_URL, disableOfflineQueue: true }) as RedisClientType;
    client.on("error", (err) => {
      console.error("[redis account lock] client error", err);
    });
    // Fail closed at boot: if Redis is configured but unreachable the
    // process refuses to start instead of silently falling back to the
    // in-process lock (which would not serialize across instances).
    await client.connect();

    return {
      lock: new RedisAccountLock(client),
      shutdown: async () => {
        await client.quit();
      },
    };
  }

  return {
    lock: new InProcessAccountLock(),
    shutdown: async () => {},
  };
}
