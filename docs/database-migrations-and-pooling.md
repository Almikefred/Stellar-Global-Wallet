# Postgres: Migrations Framework, Hot Indexes & Connection Pooling

## Overview

GlobeWallet manages PostgreSQL database evolution using an automated, transaction-safe migration runner (`backend/src/migrations/runner.ts`).

## Migrations Architecture

Applied migrations are tracked in the `schema_migrations` table:
```sql
CREATE TABLE schema_migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### CLI Commands
```bash
npm run migrate        # Run pending forward migrations
npm run migrate:down   # Rollback the most recent migration
```

### Hot Indexes for High-Scale Queries
To ensure low query latency at high load, composite indexes are established:
1. `pending_txs (account, status, created_at DESC)`: Fast lookups for co-signer pending transaction queues.
2. `pending_txs (expires_at) WHERE status = 'pending'`: Selective index for worker cleanup sweeps.
3. `idempotency_keys (created_at)`: Efficient purging of stale idempotency tokens.
4. `sessions (sub, last_used_at DESC)`: Rapid session listing and device revocation.

## Connection Pooling & PgBouncer Guidance

### Pool Configuration
In `backend/src/db.ts`, the `pg.Pool` is tuned for containerized and clustered deployments:
- `max`: 20 connections in production (10 in dev/test)
- `idleTimeoutMillis`: 30,000ms
- `connectionTimeoutMillis`: 5,000ms

### PgBouncer Integration
When deploying multiple replicas behind PgBouncer:
- Configure PgBouncer in **transaction pooling** mode (`pool_mode = transaction`).
- Do not use session-level advisory locks or prepared statements across pooled sessions.
- In `backend/.env`, set `DATABASE_URL` to the PgBouncer port (typically 6432).

### Slow Query Logging
Queries taking longer than 200ms are automatically intercepted and logged as warnings:
```
[postgres] SLOW QUERY (245ms): SELECT * FROM pending_txs WHERE account = $1...
```
