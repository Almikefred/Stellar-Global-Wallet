# Transaction Submission Changes

## Overview

Transaction submission has been refactored to eliminate ambiguous outcomes and provide clear status tracking. Previously, gateway timeouts (504) left clients uncertain about whether their transaction landed on the ledger.

## Status Taxonomy

Transactions now have clear, machine-readable status values:

| Status | Description |
|--------|-------------|
| `submitting` | Transaction has been submitted, waiting for first status |
| `pending` | Transaction is in the ledger but not confirmed (or submission timed out) |
| `success` | Transaction successfully landed on the ledger |
| `expired` | Transaction `timeBounds.maxTime` has passed |
| `failed` | Transaction was rejected by Horizon with a result code |
| `unknown` | Submission timed out (504) - client must query later |

## Async Submission Flow

### Before (Synchronous)

```
Client → Submit → [504 Gateway Timeout] → Unknown result
```

### After (Async with Polling)

```
Client → Submit → Returns immediately with status tracking
             ↓
         Redis publishes status changes via SSE
             ↓
         Client polls /api/v1/transactions/status/{hash}
             ↓
         Status updated to: success/pending/failed/expired
```

## API Changes

### Submission Endpoints

Submission endpoints now return immediately and track status:

```typescript
// Before
const result = await stellar.sendPayment(params);
// result: { hash, ledger, successful } | throws error

// After
const result = await submitter.sendPayment(params);
// result: { hash, ledger, successful } | { hash, status: "pending" }

// Client can then poll for status:
const status = await fetch(`/api/v1/transactions/status/${hash}`);
// status: { hash, accountId, status, ledger?, errorMessage?, ... }
```

### Status Endpoints

New endpoints for querying transaction status:

```http
GET /api/v1/transactions/status/:hash

Response:
{
  "hash": "abc123...",
  "accountId": "G...",
  "status": "success" | "pending" | "failed" | "expired" | "unknown",
  "ledger": 12345,        // Optional
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:01:00.000Z",
  "errorMessage": "...",  // Optional
  "resultCodes": "..."    // Optional
}
```

```http
GET /api/v1/transactions/account/:accountId/statuses?limit=20

Response:
{
  "transactions": [...]
}
```

## Migration Guide

### For API Clients

1. **Handle the new response shape**

   Submission endpoints may now return `{ hash, status: "pending" }` instead of immediate success/failure.

   ```javascript
   const result = await submitTransaction(tx);
   
   if (result.status === "pending") {
     // Poll for status
     const status = await pollStatus(result.hash);
   }
   ```

2. **Subscribe to SSE updates (optional)**

   Clients can subscribe to Redis pub/sub channel `transaction-status` for real-time updates:

   ```javascript
   const pubsub = redis.duplicate();
   await pubsub.connect();
   await pubsub.subscribe("transaction-status", (message) => {
     const { hash, status, ledger } = JSON.parse(message);
     console.log(`Transaction ${hash} is now ${status}`);
   });
   ```

### For Backend Deployments

1. **Add database migration**

   ```sql
   CREATE TABLE IF NOT EXISTS transaction_status (
     hash VARCHAR(64) PRIMARY KEY,
     account_id VARCHAR(56) NOT NULL,
     status VARCHAR(20) NOT NULL,
     ledger BIGINT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     error_message TEXT,
     result_codes TEXT,
     fee VARCHAR(20),
     operation_count INTEGER
   );
   
   CREATE INDEX IF NOT EXISTS transaction_status_account_idx 
     ON transaction_status (account_id, created_at DESC);
   ```

2. **Configure Redis** (optional, for real-time updates)

   Ensure Redis is configured and accessible for status publishing.

3. **Update service wiring**

   ```typescript
   const txStore = new PgTransactionStore(dbPool);
   const txSubmitter = new TransactionSubmitter({
     horizonService,
     accountLock,
     statusStore: {
       record: async (hash, accountId) => await txStore.create({...}),
       update: async (hash, status, details) => await txStore.update(hash, status, details),
     },
   });
   ```

## Benefits

1. **No ambiguous outcomes** - All transactions have a definitive status
2. **Real-time visibility** - SSE push for status changes
3. **Client polling** - Reliable fallback for status resolution
4. **Retry transparency** - Clients see exactly which transactions need retry
5. **Debuggability** - Error messages and result codes persisted

## Rollback Plan

If issues are detected:

1. Revert to `stellar.ts` from commit `6fc71e5`
2. Drop `transaction_status` table if created
3. Clear Redis `transaction-status` channel if used

## Monitoring

New metrics:

- `wallet_transaction_status_submitted_total` - Submissions started
- `wallet_transaction_status_success_total` - Successful submissions
- `wallet_transaction_status_failed_total` - Failed submissions  
- `wallet_transaction_status_unknown_total` - Unknown status (polling required)
- `wallet_transaction_status_poll_duration_ms` - Time to resolve status

## Future Work

- [ ] Fee escalation on `tx_insufficient_fee` (surge pricing)
- [ ] Automatic rebuild with higher fee for expired transactions
- [ ] Batch status polling endpoint for multiple transactions
- [ ] Webhook configuration for external status notifications
