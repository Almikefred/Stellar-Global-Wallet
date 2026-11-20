# Graceful Shutdown & In-Flight Submission Safety

## Summary

When deploying updates or scaling instances, incoming requests, open SSE streams, and in-flight transactions must not be abruptly terminated. Abrupt terminations cause ambiguous transaction outcomes for users (e.g. money sent on-chain while client receives a dropped socket or 502 Bad Gateway).

## Architecture & Lifecycles

GlobeWallet implements a coordinated shutdown sequence managed by `shutdownManager`:

```
SIGTERM / SIGINT Received
       │
       ▼
1. Mark `isShuttingDown = true`
   - Future HTTP requests immediately rejected with 503 Service Unavailable + `Connection: close`
       │
       ▼
2. `server.close()`
   - Closes listening socket; stops accepting new TCP connections
       │
       ▼
3. Close Active SSE Streams
   - Sends `event: shutdown\ndata: {"status":"shutting_down","retryAfter":3}\nretry: 3000\n\n`
   - Closes responses so clients can cleanly reconnect to sibling instances
       │
       ▼
4. Stop Background Watchers & Indexers
   - `stopActivityFeedIndexer()`
   - `stopTtlKeeper()`
   - `stopUpgradeWatcher()`
       │
       ▼
5. Drain In-Flight HTTP Requests & Submissions
   - Submissions (`/wallet/submit`, `/contract/wallet/submit`, `/submit-multisig`) tracked via `shutdownManager.trackSubmission`
   - Waits up to `SHUTDOWN_TIMEOUT_MS` (default 25s) for operations to complete
       │
       ▼
6. Resource Teardown & Lock Release
   - `await shutdown()` (releases Redis / in-process account locks)
   - `await pool.end()` (drains PostgreSQL connections)
   - Exit with code 0
```

## Cloud Platform & Kubernetes Grace Periods

### Render Blueprint

Render sends `SIGTERM` and allows a **30-second grace period** before issuing `SIGKILL`. GlobeWallet sets `SHUTDOWN_TIMEOUT_MS=25000` (25 seconds) to ensure that all locks are released and databases cleanly closed at least 5 seconds before Render's hard kill deadline.

### Kubernetes (`deployment.yaml`)

Configure Kubernetes pods with:

```yaml
spec:
  terminationGracePeriodSeconds: 35
  containers:
    - name: globewallet-api
      env:
        - name: SHUTDOWN_TIMEOUT_MS
          value: "30000"
```
