# Timeout Budgets & Retry Policies: Operations Guide

This guide documents the resilience configuration for all external service dependencies, including timeout budgets, retry policies, and tuning guidance for operators.

## Overview

The Credence Backend implements a layered timeout and retry strategy:

1. **Timeout Budgets** (`src/lib/timeouts.ts`): Per-ServiceType defaults, minimums, maximums, and hard caps
2. **Retry Policies** (`src/lib/retryPolicy.ts`): Exponential backoff, jitter strategies, and per-provider overrides
3. **Environment Variables** (`src/config/index.ts`): Runtime tuning without code changes
4. **Timeout Executor** (`src/lib/timeoutExecutor.ts`): Unified wrapper for all service calls with observability
5. **Global Request Budgets** (`src/middleware/timeoutBudget.ts` & `src/utils/timeoutContext.ts`): Enforces an absolute upper bound per-request.

## Global Request Budgets

Every incoming request is wrapped in an `AsyncLocalStorage` context that tracks a global deadline. The global budget limits the *total* time a request can spend executing, ensuring long-running requests fail fast.

- **Environment Variable**: `TIMEOUT_GLOBAL_MS` (default: 30000)
- **Header Override**: `x-timeout-ms` (clients can optionally request a stricter timeout, up to `TIMEOUT_GLOBAL_MS`)

When a downstream call (e.g., DB query, HTTP request) is made, its specific service budget is evaluated against the *remaining* global budget. If the remaining budget is smaller than the requested service timeout, the timeout is clamped to the remaining global budget.

## Service Type Timeout Budgets

Each ServiceType has a `TimeoutBudget` with four values:
- **defaultMs**: Used when no override is provided
- **minMs**: Minimum allowed (prevents too-aggressive timeouts)
- **maxMs**: Maximum allowed per budget (additional safety limit)
- **targetMs**: SLO-aligned target for healthy operations

Hard caps in `TIMEOUT_HARD_CAPS` prevent misconfiguration from cascading.

### Database

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 2000 ms | `DEFAULT_TIMEOUT_BUDGETS.database` | `TIMEOUT_DB_MS` (default: 2000) |
| **minMs** | 100 ms | | |
| **maxMs** | 10000 ms | | |
| **targetMs** | 1000 ms | | |
| **Hard Cap** | 30000 ms | `TIMEOUT_HARD_CAPS.database.maxMs` | |

**Usage**: Queries and transactions via Knex/SQLite. The 2s default balances responsiveness with the overhead of complex transaction coordination.

**Tuning**: Raise if experiencing timeouts on complex joins or transaction locks. Safe range: 500ms–10s.

---

### Cache (Redis)

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 500 ms | `DEFAULT_TIMEOUT_BUDGETS.cache` | `TIMEOUT_CACHE_MS` (default: 500) |
| **minMs** | 50 ms | | |
| **maxMs** | 2000 ms | | |
| **targetMs** | 200 ms | | |
| **Hard Cap** | 10000 ms | `TIMEOUT_HARD_CAPS.cache.maxMs` | |

**Usage**: Redis GET/SET, cache invalidation, governance proposal storage.

**Tuning**: Redis is co-located and fast; raise only if experiencing network latency or Redis slowdown. Safe range: 100ms–2s.

---

### Queue

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 1000 ms | `DEFAULT_TIMEOUT_BUDGETS.queue` | `TIMEOUT_QUEUE_MS` (default: 1000) |
| **minMs** | 100 ms | | |
| **maxMs** | 5000 ms | | |
| **targetMs** | 500 ms | | |
| **Hard Cap** | 15000 ms | `TIMEOUT_HARD_CAPS.queue.maxMs` | |

**Usage**: Message publishing and consumption (future queue integration).

**Tuning**: Safe range: 200ms–5s. Increase for batch operations.

---

### HTTP (Outbound)

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 5000 ms | `DEFAULT_TIMEOUT_BUDGETS.http` | `TIMEOUT_HTTP_MS` (default: 5000) |
| **minMs** | 1000 ms | | |
| **maxMs** | 30000 ms | | |
| **targetMs** | 3000 ms | | |
| **Hard Cap** | 60000 ms | `TIMEOUT_HARD_CAPS.http.maxMs` | |

**Usage**: Third-party API calls (external services, webhooks inbound).

**Tuning**: External services are slow and unreliable. Safe range: 1s–30s. Pair with retry policy.

---

### Soroban (Blockchain RPC)

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 5000 ms | `DEFAULT_TIMEOUT_BUDGETS.soroban` | `TIMEOUT_SOROBAN_MS` (default: 5000) |
| **minMs** | 100 ms | | |
| **maxMs** | 15000 ms | | |
| **targetMs** | 4000 ms | | |
| **Hard Cap** | 45000 ms | `TIMEOUT_HARD_CAPS.soroban.maxMs` | |

**Usage**: Stellar RPC calls (transaction submission, contract invocation).

**Tuning**: Network-dependent; blockchain operations are variable. Safe range: 1s–15s. Higher timeouts improve reliability under congestion.

---

### Webhook Delivery (Outbound)

| Field | Value | Source | Environment Variable |
|-------|-------|--------|----------------------|
| **defaultMs** | 10000 ms | `DEFAULT_TIMEOUT_BUDGETS.webhook` | `TIMEOUT_WEBHOOK_MS` (default: 10000) |
| **minMs** | 2000 ms | | |
| **maxMs** | 30000 ms | | |
| **targetMs** | 8000 ms | | |
| **Hard Cap** | 60000 ms | `TIMEOUT_HARD_CAPS.webhook.maxMs` | |

**Usage**: Outbound webhook delivery to customer endpoints.

**Tuning**: Customer services are unpredictable. 10s is generous by default. Safe range: 2s–30s. Longer timeouts reduce false positives but increase backpressure.

---

## Retry Policies

### Default Retry Configuration

| Field | Default Value | Hard Cap | Environment Variable |
|-------|---------------|----------|----------------------|
| **maxAttempts** | 3 | 10 | `OUTBOUND_RETRY_MAX_ATTEMPTS` |
| **baseDelayMs** | 200 | 60000 | `OUTBOUND_RETRY_BASE_DELAY_MS` |
| **maxDelayMs** | 2000 | 300000 | `OUTBOUND_RETRY_MAX_DELAY_MS` |
| **backoffMultiplier** | 2 | 10 | `OUTBOUND_RETRY_BACKOFF_MULTIPLIER` |
| **jitterStrategy** | 'none' | — | `OUTBOUND_RETRY_JITTER_STRATEGY` |

**Formula**: `delay = min(baseDelay * multiplier^(attempt - 1), maxDelay)`

With jitter applied if strategy is 'full' or 'equal':
- **'none'**: No jitter; deterministic delays
- **'full'**: Random delay in [0, cappedDelay)
- **'equal'**: Random delay in [cappedDelay/2, cappedDelay)

---

### Provider-Specific Overrides

Providers can override retry policy fields independently. Set to override the defaults; omit to inherit defaults.

#### Soroban Overrides

| Field | Environment Variable |
|-------|----------------------|
| **maxAttempts** | `OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS` (optional) |
| **baseDelayMs** | `OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS` (optional) |
| **maxDelayMs** | `OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS` (optional) |
| **backoffMultiplier** | `OUTBOUND_RETRY_SOROBAN_BACKOFF_MULTIPLIER` (optional) |
| **jitterStrategy** | `OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY` (optional) |

**Example**:
```bash
OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS=5
OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS=100
OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS=5000
```

#### Webhook Overrides

| Field | Environment Variable |
|-------|----------------------|
| **maxAttempts** | `OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS` (optional) |
| **baseDelayMs** | `OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS` (optional) |
| **maxDelayMs** | `OUTBOUND_RETRY_WEBHOOK_MAX_DELAY_MS` (optional) |
| **backoffMultiplier** | `OUTBOUND_RETRY_WEBHOOK_BACKOFF_MULTIPLIER` (optional) |
| **jitterStrategy** | `OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY` (optional) |

---

## Downstream Error Classification

Before the retry policy decides *how long* to wait, the **downstream error classifier** (`src/utils/retryClassifier.ts`) decides *whether* an error is retriable and *what kind* of failure it was. It surfaces a single typed value so callers branch on a stable `class` instead of inspecting raw error internals (syscall codes, undici wrappers, JSON-RPC envelopes).

### Error classes

| Class | Meaning | Retriable by default |
|-------|---------|----------------------|
| `TIMEOUT_ERROR` | Request exceeded its deadline — AbortController abort or an OS socket timeout (`ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ECONNABORTED`). | Yes |
| `NETWORK_ERROR` | Connection-level transport failure — reset (`ECONNRESET`/`EPIPE`), refused (`ECONNREFUSED`), or a generic undici `fetch failed`. The request never got a usable response. | Yes |
| `RPC_ERROR` | Transport succeeded but the downstream returned a JSON-RPC error object. | Only for transient RPC codes (see below) |

`TIMEOUT_ERROR` is kept distinct from `NETWORK_ERROR` because the operator remedy differs: a timeout usually means *raise the budget or the upstream is slow*, while a network error means *the endpoint is unreachable*. Timeout is resolved before generic network, so an abort wrapped as a reset is still surfaced as `TIMEOUT_ERROR`.

### Retriable RPC codes

The set of transient JSON-RPC codes lives in a single constant, `RETRYABLE_RPC_ERROR_CODES`, and is reused everywhere (e.g. `SorobanClient.isRetryable`) so the list is never duplicated as inline magic numbers:

| Code | Meaning |
|------|---------|
| `-32004` | Resource not yet available (e.g. Soroban "transaction not found" while the ledger catches up). |
| `-32005` | Try again later (transient backend unavailability). |

Any other RPC code classifies as `RPC_ERROR` with `retryable: false`.

### Usage

```typescript
import { classifyDownstreamError } from 'src/utils/retryClassifier.js'

try {
  return await callDownstream()
} catch (err) {
  const classified = classifyDownstreamError(err)
  if (classified === null) throw err // not a recognised downstream failure

  switch (classified.class) {
    case 'TIMEOUT_ERROR':
    case 'NETWORK_ERROR':
      // always retriable transport failures
      break
    case 'RPC_ERROR':
      if (!classified.retryable) throw err // permanent RPC error (e.g. invalid params)
      break
  }
  // classified.retryable carries the decision; feed the attempt into the retry policy above
}
```

`classifyDownstreamError` returns `null` for values that are not recognised downstream failures (programming errors, parse failures), leaving the caller to surface them rather than forcing them into a transport bucket.

---

## Timeout Executor Wrappers

The timeout executor (`src/lib/timeoutExecutor.ts`) wraps all service calls with consistent timeout handling:

```typescript
import { executeDbOperation, executeHttpRequest, executeSorobanOperation } from 'src/lib/timeoutExecutor.js'

// Database calls use database timeout budget
const rows = await executeDbOperation(() => db.select().from('table'))

// HTTP calls use http timeout budget
const response = await executeHttpRequest(() => fetch(url))

// Soroban calls use soroban timeout budget
const result = await executeSorobanOperation(() => rpc.simulateTransaction(tx))
```

Each wrapper:
1. Resolves the timeout from budget (or per-call override)
2. Wraps the operation with a Promise.race against a timeout timer
3. Emits observability events (success or timeout)
4. Throws `TimeoutExceededError` on timeout

---

## Circuit Breaker Integration

Timeout behavior interacts with circuit breakers:

- **Open state**: Requests fail fast without calling the service
- **Half-open state**: One request is allowed to test recovery; timeout respects the timeout budget
- **Closed state**: Normal timeout behavior applies

A repeated timeout pattern triggers the circuit breaker to open, preventing cascading failures.

---

## Tuning Runbook

### Symptom: Frequent Timeout Errors

**Diagnose:**
```bash
# Check logs for TimeoutExceededError and the serviceType
grep "TimeoutExceededError" logs/ | grep "database\|soroban\|http"

# Check current timeout configuration
env | grep TIMEOUT_
```

**Tune:**

| Service | Action | Example |
|---------|--------|---------|
| **Database** | Raise `TIMEOUT_DB_MS` if queries are slow but not actually failing | `TIMEOUT_DB_MS=5000` |
| **Cache** | Check Redis health; timeouts suggest network/load issues, not configuration | Restart Redis or scale |
| **HTTP** | Raise `TIMEOUT_HTTP_MS`; consider retry policy | `TIMEOUT_HTTP_MS=10000` |
| **Soroban** | Raise `TIMEOUT_SOROBAN_MS`; blockchain is variable | `TIMEOUT_SOROBAN_MS=10000` |
| **Webhook** | Raise `TIMEOUT_WEBHOOK_MS`; customer services are unpredictable | `TIMEOUT_WEBHOOK_MS=15000` |

⚠️ **Warning**: Raising timeouts masks slow services. Investigate root cause (slow DB query, network latency) before increasing.

---

### Symptom: Cascading Failures / Circuit Breaker Trips

**Diagnose:**
```bash
# Check if circuit breaker is open
grep "circuit breaker.*open" logs/

# Correlate with timeout errors
grep "TimeoutExceededError.*soroban\|webhook" logs/
```

**Tune:**

1. **Investigate**: Is the service actually slow, or is the timeout too aggressive?
   - If timeouts are false positives (service recovers quickly), raise timeout
   - If service is genuinely slow, scale it (more DB connections, Soroban node upgrade)

2. **Adjust Retry Policy**: More retries with jitter reduce false positives
   ```bash
   OUTBOUND_RETRY_MAX_ATTEMPTS=5
   OUTBOUND_RETRY_JITTER_STRATEGY=equal
   ```

3. **Stagger Load**: Jitter spreads retry storms
   ```bash
   OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY=full
   OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY=equal
   ```

---

### Symptom: Latency Spikes Under Load

**Diagnose:**
```bash
# Check if timeouts increase under load
# Correlate with request volume in metrics/logs
```

**Tune:**

1. **Reduce aggressive timeouts** on non-critical paths
   ```bash
   TIMEOUT_CACHE_MS=300  # Non-critical cache read
   ```

2. **Increase retry delays** to reduce thundering herd
   ```bash
   OUTBOUND_RETRY_BASE_DELAY_MS=500
   OUTBOUND_RETRY_MAX_DELAY_MS=5000
   ```

3. **Reduce max concurrent retries** via circuit breaker config

---

## Environment Variable Reference

All timeout and retry env vars with defaults:

```bash
# Timeout budgets (milliseconds)
TIMEOUT_GLOBAL_MS=30000
TIMEOUT_DB_MS=2000
TIMEOUT_CACHE_MS=500
TIMEOUT_QUEUE_MS=1000
TIMEOUT_HTTP_MS=5000
TIMEOUT_SOROBAN_MS=5000
TIMEOUT_WEBHOOK_MS=10000

# Default retry policy
OUTBOUND_RETRY_MAX_ATTEMPTS=3
OUTBOUND_RETRY_BASE_DELAY_MS=200
OUTBOUND_RETRY_MAX_DELAY_MS=2000
OUTBOUND_RETRY_BACKOFF_MULTIPLIER=2
OUTBOUND_RETRY_JITTER_STRATEGY=none

# Provider-specific overrides (all optional)
OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS=
OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS=
OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS=
OUTBOUND_RETRY_SOROBAN_BACKOFF_MULTIPLIER=
OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY=

OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS=
OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS=
OUTBOUND_RETRY_WEBHOOK_MAX_DELAY_MS=
OUTBOUND_RETRY_WEBHOOK_BACKOFF_MULTIPLIER=
OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY=

# Pool idle-connection timeout (milliseconds)
# Connections idle longer than this are closed and removed from the pool.
# Prevents stale connections from accumulating and keeps pool counts predictable.
DB_POOL_IDLE_TIMEOUT_MS=300000   # 5 minutes (default)
```

---

## Connection Pool Idle Timeout

The `idleTimeoutMillis` option controls how long a connection can remain idle in
the pool before it is automatically closed and evicted. This keeps the live
connection count predictable and reclaims OS resources held by connections that
are no longer needed.

### Default behaviour

All three pools (API, worker, replica) share the same `DB_POOL_IDLE_TIMEOUT_MS`
value:

| Pool | Purpose | Idle timeout |
|------|---------|--------------|
| `pool` | Route handlers and services | `DB_POOL_IDLE_TIMEOUT_MS` |
| `workerPool` | Background jobs (outbox, exports) | `DB_POOL_IDLE_TIMEOUT_MS` |
| `replicaPool` | Read-heavy endpoints | `DB_POOL_IDLE_TIMEOUT_MS` |

The default is **300 000 ms (5 minutes)**, chosen because:
- Short enough to reclaim connections after a traffic lull (e.g. nightly quiet
  period or after a burst).
- Long enough not to thrash the pool on workloads that naturally pause for tens
  of seconds between bursts.

### Tuning

| Scenario | Recommendation |
|----------|---------------|
| Very low-traffic service | Lower to `60000` (1 min) to free connections sooner |
| High-frequency background jobs | Raise to `600000` (10 min) to avoid reconnect overhead |
| Connection-limit-constrained DB | Lower to reap idle connections more aggressively |

```bash
# Example: reclaim idle connections after 1 minute
DB_POOL_IDLE_TIMEOUT_MS=60000

# Example: tolerate longer idle periods for batch-heavy workloads
DB_POOL_IDLE_TIMEOUT_MS=600000
```

### Related pool env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_IDLE_TIMEOUT_MS` | `300000` | Milliseconds before an idle connection is closed |
| `DB_POOL_MAX` | `20` | Max connections in the API / replica pool |
| `DB_WORKER_POOL_MAX` | `5` | Max connections in the worker pool |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Max wait time for a free connection |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout (kills runaway queries) |

---

## Long Transaction Reaper

`DB_STATEMENT_TIMEOUT_MS` bounds a single statement, but it resets on every
new statement within a transaction — it does nothing for an idle-in-transaction
session (no statement is running) or a transaction built from many small,
fast statements separated by slow application-level work. Either shape holds
row/table locks and blocks autovacuum for as long as the transaction stays
open. Waiters queue up behind the stale locks, their own connections stay
checked out of the pool while they wait, and the pool eventually saturates —
a hold-off cascade.

`LongTransactionReaper` (`src/jobs/longTransactionReaper.ts`) closes this gap
by periodically scanning `pg_stat_activity` and calling
`pg_terminate_backend()` on any client backend whose transaction has been
open longer than the configured max age.

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_LONG_TRANSACTION_REAPER_ENABLED` | `true` | Master on/off switch |
| `DB_LONG_TRANSACTION_MAX_AGE_MS` | `30000` | Transactions open longer than this are terminated |
| `DB_LONG_TRANSACTION_REAPER_INTERVAL_MS` | `10000` | How often `pg_stat_activity` is scanned |
| `DB_LONG_TRANSACTION_REAPER_DRY_RUN` | `false` | Log/count over-age transactions without terminating them |

---

## Further Reading

- **Observability** (metrics, tracing): [`docs/observability.md`](./observability.md)
- **Circuit Breaker**: Link to circuitBreaker.ts when available
- **Lock Timeout Configuration** (database-specific): [`docs/lock-timeout-configuration.md`](./lock-timeout-configuration.md)
- **Monitoring** (alerting on timeouts): [`docs/monitoring.md`](./monitoring.md)
