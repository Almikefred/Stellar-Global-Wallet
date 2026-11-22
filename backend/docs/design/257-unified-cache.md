# #257: Unified cache with stampede protection

**Status:** proposed · **Size:** L · **Touches:** `src/services/sorobanCache.ts`,
`src/services/soroban.ts`, new `src/services/cache/`, `src/config.ts`,
`docs/performance.md`

## Current state

The issue lists three helpers (`jsonCache.ts`, `ttlCache.ts`,
`sorobanCache.ts`). On `main` only **`sorobanCache.ts`** exists. Price,
account and other reads have no cache. This note therefore designs the shared
abstraction and moves `sorobanCache` onto it. If `jsonCache`/`ttlCache` land
from another branch first, they move onto it in the same way (see
[Migration](#migration)).

What `sorobanCache.ts` does today:

- Redis only, fixed 15 s TTL, key `orbit-wal:soroban-cache:{contractId}:{method}:{base64(args)}`.
- Read-through is hand-rolled in `SorobanService.simulate`: get → miss →
  simulate → set.
- **No single-flight.** N concurrent identical reads on a cold or just-expired
  key each run their own `getAccount` + `simulateTransaction` RPC round-trip.
  That is the stampede.
- Metrics are `console.log` HIT/MISS lines, one per request on the hot path.
- Owns its own Redis client, separate from the lock backend's client.
- Fails open on Redis errors, which is correct and is kept.
- `bustContractCache` uses SCAN+DEL. That is correct, but every key for a
  contract is invalidated, and nothing calls it today.

## Goals

1. One `Cache` interface with consistent semantics: TTL, JSON values, fail-open.
2. Two tiers: an in-process LRU (L1) in front of Redis (L2). Either can be disabled.
3. **Single-flight:** concurrent misses for the same key in one process cause exactly one load.
4. **Stale-while-revalidate (SWR):** inside a grace window after expiry, serve the stale value and refresh it in the background.
5. Metrics (hits, misses, stale serves, load latency, load errors) without logging every request.

## Design

```ts
// src/services/cache/types.ts
export interface CacheOptions {
  ttlMs: number;          // fresh for this long
  staleMs?: number;       // after ttl, may be served stale for this long while refreshing (default 0)
  tiers?: ("memory" | "redis")[]; // default ["memory", "redis"]
}

export interface Cache {
  /** Read-through: returns cached, or runs `load` once per key across concurrent callers. */
  getOrLoad<T>(key: string, load: () => Promise<T>, opts: CacheOptions): Promise<T>;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts: CacheOptions): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export function createCache(namespace: string, deps?: { redis?: RedisLike; clock?: () => number }): Cache;
```

### Stored entry

```ts
interface Entry<T> { v: T; freshUntil: number; staleUntil: number; }
```

The same JSON shape is used in both tiers. The Redis `PX` is set to
`staleUntil - now`, so Redis evicts stale entries on its own.
`undefined` is never cached. `null` *is* cached when the loader returns it
(negative caching), but only if the caller opts in via `cacheNull: true`.

### `getOrLoad` algorithm

1. Look in L1. Fresh → return it (`hit{tier=memory}`).
2. Look in L2. Fresh → promote to L1 → return it (`hit{tier=redis}`).
3. If the entry is stale but inside `staleUntil`, return the stale value
   (`stale`) and start a background refresh through the single-flight map.
   Errors from that refresh are logged and counted, never thrown.
4. Otherwise (miss): `inflight.get(key) ?? inflight.set(key, load())`. Await
   it, write both tiers, and delete the entry from `inflight` in `finally`.

The **single-flight map** is a `Map<string, Promise<unknown>>` per process.
Errors are shared with every waiter and are **not** cached. The next call
retries.

**Cross-instance stampede (optional, off by default):** before loading, try
`SET key:lock NX PX=loadTimeout`. Losers wait briefly (poll L2 up to
`loadTimeout`) and then load themselves anyway. This is a best-effort guard,
and the system is still correct without it. It is off by default because
single-flight plus SWR already caps the load at about one request per instance
per key per TTL, which is fine for the current deployment size.

### Keys

`{global prefix}:{namespace}:{key}`. The global prefix comes from config and
defaults to the existing `orbit-wal`. The Soroban namespace keeps the existing
key layout, so a rolling deploy reads the old entries.

### Redis client

Use one shared, lazily connected client from `src/services/redis.ts`, reused by
the lock backend where possible. A Redis error marks L2 "down" for a short
backoff (default 5 s). During the backoff calls skip L2 instead of paying a
connection timeout on every request. This is a simple circuit breaker.

### Metrics

There is no metrics library in the repo today. The cache exposes counters
through a tiny in-process registry (`src/services/metrics.ts`):

- `cache_requests_total{namespace, result=hit|miss|stale, tier}`
- `cache_load_duration_ms{namespace}` (histogram buckets)
- `cache_load_errors_total{namespace}`
- `cache_backend_errors_total{namespace, tier}`

The registry can be read through an admin-only endpoint or as a periodic
summary log line every 60 s. The per-request `console.log` lines go away.
Replacing the registry with prom-client later is a one-file change.

## Migration

| Today | After |
|---|---|
| `getCachedSimulate` / `setCachedSimulate` in `soroban.ts` | `sorobanCache.getOrLoad(argsKey, () => simulateUncached(...), { ttlMs: 15_000, staleMs: 5_000 })` |
| `bustContractCache(contractId)` | `sorobanCache.deletePrefix(contractId + ":")`. The L1 delete is local only; see failure modes. |
| `jsonCache.ts` / `ttlCache.ts` (if they appear) | Thin wrappers re-exporting `createCache(...)` for one release, then removed. |

`sorobanCache.ts` keeps its exported function names as deprecated wrappers
until all callers move over, so the change is mechanical and API behaviour is
unchanged.

## Threat model

| Threat | Mitigation |
|---|---|
| Cache poisoning / cross-user leakage: a key that does not include everything the result depends on returns one caller's data to another | Keys are built by the caller from the **complete** input (contract id, method, full arg XDR). Simulate results are public chain state. Never cache per-user secrets or anything derived from a JWT `sub`. Documented on `createCache`. |
| Key injection (`:` / `*` in user-controlled key parts making `deletePrefix` over-match) | Key parts are hashed or encoded (base64url) by the caller. `deletePrefix` escapes glob metacharacters before MATCH. |
| Memory exhaustion through unbounded L1 | L1 is an LRU with `maxEntries` (default 1000) and `maxBytes` (approximate, from the JSON length). Values over a size cap are not cached in L1. |
| Stale data used for a write decision (e.g. a spend limit check) | SWR is opt-in per call site. Writes and pre-write checks call the uncached path. `record_spend` already goes through `invoke`, which is not cached. |
| Redis outage → latency spike | Fail open, plus the circuit-breaker backoff. |

## Data model

Redis keys only: `orbit-wal:{ns}:{key}` → JSON `Entry`, `PX` = stale horizon.
There is no Postgres change. The idempotency table (`idempotency_keys`) is
**not** a cache. It is a correctness record, so it stays in Postgres and does
not move to this abstraction.

## Failure modes

- **Redis down:** L1 keeps serving and loads go straight to the source. Errors are counted, never thrown.
- **The loader throws:** the error goes to every concurrent waiter, nothing is cached, and the stale value (if any, inside the window) is served instead for SWR reads.
- **The loader hangs:** it is bounded by an optional `loadTimeoutMs`. On timeout the in-flight entry is cleared so later calls can retry.
- **Multi-instance L1 incoherence:** `deletePrefix` clears L2 and only the *local* L1. Other instances serve their L1 copy until its TTL ends, at most `ttlMs` (15 s). This is acceptable for chain reads. If tighter coherence is needed later, use Redis pub/sub invalidation (deferred).
- **Clock skew between instances:** freshness is decided by the reader's clock against `freshUntil` written by another instance. Skew of a few seconds only shifts the window slightly. The Redis `PX` is the hard bound.
- **Serialization:** bigint/i128 values from `scValToNative` cannot be JSON-serialised. The cache encodes them with a tagged replacer (`{"$bigint":"123"}`) and decodes them on read. Today, any simulate result that contains an i128/u64 (for example a timestamp in the pending-upgrade state) makes `JSON.stringify` throw. `setCachedSimulate` swallows that error, so those reads are silently never cached. Confirm which reads are affected with a test.

## Test plan

Use a fake clock and an in-memory Redis fake (or `ioredis-mock`). There are no real timers.

- **Concurrent misses ⇒ one load:** 50 parallel `getOrLoad` calls on a cold
  key with a deferred loader. Assert the loader was called once and all 50
  callers got the same value.
- Same with the loader rejecting: one call, all 50 reject, and the next call loads again.
- SWR: after `ttl` and before `ttl+stale`, the stale value returns immediately and exactly one background load runs. After `ttl+stale` it is a blocking load.
- Tiering: an L2 hit promotes to L1, and with L1 disabled behaviour matches L2-only.
- Redis throwing on get/set: the call still resolves through the loader, and the backoff skips L2 on the following call.
- `deletePrefix` with glob metacharacters only deletes the intended keys.
- bigint round-trip.
- `SorobanService.simulate`: existing tests pass, plus one new test that two
  concurrent identical simulates make one RPC call.

## Docs

`docs/performance.md`: a cache section covering namespaces, TTLs, SWR policy
per call site, metrics names and invalidation guarantees. Update the
`sorobanCache.ts` header comment.

## Out of scope

- Caching Horizon account/balance reads (follow-up; needs an invalidation story on submit).
- Pub/sub cross-instance L1 invalidation.
- prom-client / an OpenTelemetry exporter.
