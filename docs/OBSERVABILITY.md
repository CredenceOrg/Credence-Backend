# Observability: Request Tracing & Metrics

To facilitate debugging in our distributed environment, every request is assigned a `Request ID` and a `Correlation ID`.

- **X-Request-ID**: Unique identifier for the HTTP call. If provided in the incoming request headers, we preserve it. We also propagate it to downstream RPC calls (using Connect-RPC interceptors) and emit it automatically in every log line during the request lifecycle.
- **X-Correlation-ID**: Persists across services. Handled by the dedicated `correlationIdMiddleware` (`src/middleware/correlationId.ts`). If an upstream service sends one, we propagate it; otherwise a UUID v4 is generated automatically. The resolved ID is stored on `req['correlationId']` for downstream handlers and echoed in every response.

## Log Format

All logs emitted during a request lifecycle include these IDs automatically:
`[INFO] [RequestID: <uuid>] [CorrelationID: <uuid>] - <message>`

## PII Redaction Filter (Issue #390)

### Overview

The Credence Backend implements **allowlist-based PII redaction** for all structured logs. This ensures that sensitive data (passwords, tokens, API keys, PII, etc.) is redacted **before serialization**, preventing data leaks in log aggregation systems and heap dumps.

**SECURITY CRITICAL**: Redaction happens before `JSON.stringify()` to ensure PII never appears in serialized logs.

### Allowlist Schema Pattern

Instead of maintaining a denylist of sensitive field names (which misses renamed/nested fields), we use an allowlist schema per log event type:

```typescript
import { LogEventType } from "src/observability/logSchemas";
import { redact } from "src/observability/redaction";

// Define what fields are ALLOWED for this event type
const logEvent = {
  message: "Payment processed",
  amount: 150.0,
  currency: "USD",
};

// Redact with schema context
const redacted = redact(logEvent, {
  eventType: LogEventType.OUTBOX_PUBLISHER_PUBLISHED_EVENT,
});

// Result: Only 'message' is kept (per schema)
// All other fields are dropped
```

### How It Works

1. **Schema Definition** (`src/observability/logSchemas.ts`):
   - Each `LogEventType` defines which fields are allowed
   - Nested objects are validated recursively
   - Unknown fields are dropped entirely (fail-secure)

2. **Redaction Layers**:
   - **Layer 1**: Field allowlist (only schema-defined fields pass through)
   - **Layer 2**: PII pattern matching (fields like `password`, `token`, `email` are redacted regardless)
   - **Layer 3**: Stellar memo field handling (special handling for blockchain memo fields)

3. **Before Serialization**:

   ```typescript
   const input = {
     message: "Event published",
     password: "secret123",
     apiKey: "sk-12345",
     unknownField: "dropped",
   };

   // Redaction BEFORE JSON.stringify()
   const redacted = redact(input, { eventType: "event-type" });
   // redacted = { message: 'Event published', password: '[REDACTED]' }

   // Safe to serialize
   const json = JSON.stringify(redacted);
   // No sensitive data in json
   ```

### Defining a Log Schema

Edit `src/observability/logSchemas.ts` to add new event types:

```typescript
export enum LogEventType {
  YOUR_EVENT_TYPE = "your:event:type",
}

export const LOG_SCHEMAS: Record<LogEventType, Record<string, FieldSchema>> = {
  [LogEventType.YOUR_EVENT_TYPE]: {
    message: { type: "string" },
    eventId: { type: "string" },
    timestamp: { type: "string" },
    metadata: {
      type: "object",
      nested: {
        userId: { type: "string" },
        status: { type: "string" },
        // Only userId and status are allowed in metadata
        // Any other nested fields are dropped
      },
    },
  },
};
```

### Built-in PII Patterns

Fields matching these names are automatically redacted:

- **Authentication**: `password`, `token`, `authToken`, `auth_token`, `authorization`
- **Keys & Secrets**: `apiKey`, `api_key`, `secret`, `private_key`, `public_key`, `client_secret`
- **Personal Data**: `email`, `phone`, `ssn`, `creditCard`, `bankAccount`
- **Crypto**: `jti`, `sub`, `accessToken`, `refreshToken`, `idToken`

### Stellar-Specific Fields

Stellar blockchain memo fields are always redacted:

- `memo`, `memoValue`, `memoData`, `memoHash`, `memoText`, `memo_id`, `memo_return`

These can contain sensitive user data and must never appear in logs.

### Using Redaction in Logger

```typescript
import { logger } from "src/utils/logger";
import { LogEventType, redact } from "src/observability/redaction";

// Option 1: Simple string (always safe)
logger.info("Event published successfully");

// Option 2: Object with schema context (recommended for structured logs)
const event = {
  message: "Event published",
  eventId: "123",
  status: "success",
};
logger.info(event, {
  eventType: LogEventType.OUTBOX_PUBLISHER_PUBLISHED_EVENT,
});

// Option 3: Pre-redact if needed
const redacted = redact(event, {
  eventType: LogEventType.OUTBOX_PUBLISHER_PUBLISHED_EVENT,
});
logger.info(redacted);
```

### Request-Scoped Logger (`req.log`)

Inside Express handlers, use `req.log` to write logs with pre-bound request-scoped context:
```typescript
app.get("/items", (req, res) => {
  // Emits a log entry including the current request's ID, Correlation ID, Route, Tenant, and Actor.
  req.log.info("Fetching items");
  res.json({ ok: true });
});
```

### ESLint Rules for Validation

The project includes **two ESLint rules** that enforce schema-aware logging (supporting both `logger` and `req.log` calls):

| Rule | Severity | Description |
| ---- | -------- | ----------- |
| `logger-schema/require-schema-context` | warn | Flags `logger.info({...})` calls with inline objects that bypass the schema. Suggests using a `LogEventType` context. |
| `logger-schema/unvalidated-logger-call` | warn | Warns about any logger call with an inline object that may contain unredacted PII. |

```typescript
// ⚠️ Warning: logger.info() with inline object should verify PII redaction
logger.info({
  message: "Test",
  password: "secret", // Could leak if not in schema!
});

// ✅ Correct: Use string messages or pre-redacted objects
logger.info("Simple string message - always safe");

// ✅ Correct: With schema context
logger.info(
  {
    message: "Test",
    data: "value",
  },
  {
    eventType: LogEventType.GENERIC_INFO,
  },
);
```

Run ESLint:

```bash
npm run lint
# Or target a specific rule:
npx eslint src/ --rule 'logger-schema/require-schema-context: warn'
```

### Known Event Types

| Event Type                           | Schema Fields                                                     | Use Case                     |
| ------------------------------------ | ----------------------------------------------------------------- | ---------------------------- |
| `OUTBOX_PUBLISHER_STARTING`          | `message`, `config`                                               | Publisher initialization     |
| `OUTBOX_PUBLISHER_PUBLISHED_EVENT`   | `message`                                                         | Event published successfully |
| `OUTBOX_PUBLISHER_FAILED_PUBLISH`    | `message`, `error`                                                | Event publish failure        |
| `OUTBOX_PUBLISHER_EVENT_QUARANTINED` | `message`, `eventType`, `reason`, `error`                         | Poison pill/dead letter      |
| `OUTBOX_PUBLISHER_CLEANED_UP`        | `message`                                                         | Old event cleanup            |
| `OUTBOX_PUBLISHER_LEASE_RENEWED`     | `message`, `renewed`                                              | Consumer lease heartbeat     |
| `WEBHOOK_DELIVERY_RETRY`             | `message`, `provider`, `attempt`, `delayMs`, `webhookId`, `error` | Webhook retry attempt        |
| `WEBHOOK_DELIVERY_EXHAUSTED`         | `message`, `provider`, `attempts`, `errorCode`                    | All retries exhausted        |
| `SOROBAN_RETRY`                      | `message`, `provider`, `attempt`, `maxAttempts`, `delayMs`, `code`| Soroban RPC retry            |
| `HORIZON_LISTENER_STARTED`           | `message`, `cursor`, `network`                                    | Horizon listener startup     |
| `HORIZON_LISTENER_EVENT`             | `message`, `ledger`, `operationType`, `transactionHash`           | Horizon event received       |
| `HORIZON_LISTENER_ERROR`             | `message`, `error`, `cursor`                                      | Horizon listener error       |
| `STELLAR_TX_SUBMITTED`               | `message`, `transactionHash`, `ledger`, `network`                 | Stellar tx submitted         |
| `STELLAR_TX_FAILED`                  | `message`, `transactionHash`, `error`, `resultCode`               | Stellar tx failure           |
| `HTTP_REQUEST`                       | `message`, `method`, `path`, `statusCode`, `durationMs`, `requestId` | Request lifecycle         |
| `HTTP_ERROR`                         | `message`, `method`, `path`, `statusCode`, `error`, `stack`, `requestId` | Request error           |
| `AUTH_LOGIN`                         | `message`, `method`, `success`                                    | Login events                 |
| `AUTH_FAILURE`                       | `message`, `method`, `reason`                                     | Auth failure events          |
| `DB_SLOW_QUERY`                      | `message`, `query`, `durationMs`, `thresholdMs`, `pool`, `plan`   | Query exceeded slow-query threshold |
| `GENERIC_INFO` / `GENERIC_ERROR`     | `message` (+ `error`/`stack` for ERROR)                           | Fallback schemas             |

### Testing Redaction

Run the comprehensive test suite:

```bash
npm test -- redaction
```

Tests cover:

- ✅ Allowlist enforcement (unknown fields dropped)
- ✅ Deeply nested objects (3+ levels)
- ✅ Arrays of PII
- ✅ Stellar memo field handling
- ✅ Edge cases (circular refs, max depth, Maps/Sets, Buffers, Dates, Error objects)
- ✅ Security: Redaction before serialization (PII never in JSON output)
- ✅ Schema lookup and fallback behavior
- ✅ Legacy redaction backwards compatibility
- ✅ Real-world call site schema validation
- ✅ Field type 'any' with PII scanning
- ✅ Comprehensive PII pattern coverage
- ✅ 95%+ code coverage

### Edge Cases Handled

1. **Deeply Nested Objects**: Redaction applies recursively at all levels

   ```typescript
   {
     user: {
       credentials: {
         password: "secret"; // Redacted at any depth
       }
     }
   }
   ```

2. **Arrays of PII**: Each array element is redacted

   ```typescript
   {
     tokens: ["token1", "token2", "token3"]; // All marked '[REDACTED]'
   }
   ```

3. **Renamed Sensitive Fields**: Allowlist prevents renamed fields from leaking

   ```typescript
   // These don't match any schema field, so dropped entirely
   {
     pwd: 'secret',
     apitoken: 'secret2',
     key: 'secret3'
   }
   ```

4. **Stellar Memo Fields**: Special handling
   ```typescript
   {
     memo: "user-private-data"; // Always '[REDACTED]'
   }
   ```

### Migration from Legacy Denylist

The system maintains backward compatibility via `redactLegacy()`:

```typescript
// Old approach (still works, but less secure)
import { redactLegacy } from "src/observability/redaction";
const redacted = redactLegacy(obj); // Uses PII patterns only

// New approach (recommended)
import { redact } from "src/observability/redaction";
const redacted = redact(obj, { eventType: "your:event" });
```

### Performance Characteristics

- **Shallow objects** (<10 fields): <1ms
- **Nested objects** (10 levels): <5ms
- **Arrays** (1000 items): <10ms
- **Memory**: O(n) where n = object size (no copies)

### Debugging PII Issues

When a sensitive field leaks through:

1. Check if the field is in `PII_PATTERNS` → Add it if missing
2. Check if field is in schema for that event type → Add it if legitimate
3. Check if field is nested → Verify nested schema is defined
4. Check Stellar fields → Add to `STELLAR_SENSITIVE_FIELDS`

Run tests with enhanced logging:

```bash
DEBUG=redaction npm test -- redaction
```

### Related Issues & PRs

- **#390**: Allowlist-driven log redaction with schema lint rule
- **#329**: Outbox Publisher Observability (metrics)
- **#390**: ESLint plugin for logger schema validation (`require-schema-context` + `unvalidated-logger-call`)

## Database Transaction Spans

Every database transaction managed by `TransactionManager.withTransaction` creates an OpenTelemetry span named `db.tx` with the following attributes:

| Attribute      | Type   | Description                                              |
|----------------|--------|----------------------------------------------------------|
| `op`           | string | Operation label (e.g. `"process_payment"`). Set via the `op` option in `TransactionOptions`. Omitted when not provided. |
| `table_count`  | number | Number of unique SQL tables referenced inside the transaction body. Extracted from `FROM`, `INTO`, `UPDATE`, `TABLE`, and `JOIN` clauses. |

### Example

```typescript
import { TransactionManager } from '../db/transaction.js'

const txManager = new TransactionManager(pool)

const result = await txManager.withTransaction(
  async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [id])
    return rows[0]
  },
  { op: 'fetch_user' }
)
// Resulting span: db.tx { op: "fetch_user", table_count: 1 }
```

The span is created via the `withSpan` utility and exported by the configured `SpanProcessor` (ConsoleSpanExporter in dev; OTLP in production).

## Database Query Spans

Every database query executed through the connection pools (`pool`, `workerPool`, `replicaPool`) generates an OpenTelemetry span named `db.query` with the following attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `db.system` | string | Set to `"postgresql"`. |
| `db.statement` | string | The SQL query string executed. |
| `db.pool` | string | Which pool ran the query (`"api"`, `"worker"`, or `"replica"`). |
| `db.row_count` | number | The row count returned by the query (if successful). |

If the query throws an exception, the span status is set to `ERROR`, and the exception is captured/recorded on the span.

## Prepared Statement Cache

Each connection pool (`pool`, `workerPool`, `replicaPool`) keeps its own bounded LRU cache — `instrumentPreparedStatementCache` in `src/db/pool.ts` — mapping exact query text to a stable, deterministic prepared-statement `name`. The name is derived from a hash of the query text, never from an incrementing counter, so an evicted-then-reintroduced query always maps back to the same name; this is what makes the cache safe to bound and evict from without ever causing a connection to reuse a name for the wrong SQL.

When a query's text is already in the cache, the query is sent to Postgres with that `name` so the server can skip re-parsing on repeat executions on the same physical connection. Calls that already specify their own `name`, use the callback style, or contain multiple semicolon-separated statements (which Postgres cannot `PREPARE` as one command) pass through unmodified and are never cached.

### Configuration

| Variable | Default | Description |
|----------|---------|--------------|
| `DB_PREPARED_STATEMENT_CACHE_MAX` | `200` | Maximum distinct query-text shapes tracked per pool. Evicted queries still work — they just fall back to being re-parsed each call until they're queried often enough to re-enter the cache. |

### Metrics

- **`db_prepared_statement_cache_size`** (Gauge, labeled by `pool`): current number of distinct query shapes tracked in the cache, sampled at scrape time. Sustained values at `DB_PREPARED_STATEMENT_CACHE_MAX` indicate cache-miss thrash — more distinct query shapes are hitting that pool than the cache can retain, so queries are being evicted before they're ever reused. Widening `DB_PREPARED_STATEMENT_CACHE_MAX` (or reducing the number of distinct dynamic query shapes issued) relieves the pressure.

## Slow Query Logging

Every query issued through `pool`, `workerPool`, or `replicaPool` (`src/db/pool.ts`) is timed. Any query taking at least `SLOW_QUERY_THRESHOLD_MS` (default `1000`, i.e. 1 second; `0` disables the check) emits a `db:slow-query` structured log — `LogEventType.DB_SLOW_QUERY` — with the query's plan attached, and increments Prometheus metrics.

| Field         | Type   | Description                                                        |
|---------------|--------|---------------------------------------------------------------------|
| `message`     | string | `"Slow query exceeded threshold"`                                   |
| `query`       | string | The parameterized query text (e.g. `... WHERE id = $1`), truncated to 4000 characters. Bind parameter *values* are never logged. |
| `durationMs`  | number | Observed query duration, rounded to the nearest millisecond.        |
| `thresholdMs` | number | The configured `SLOW_QUERY_THRESHOLD_MS` value at the time of the call. |
| `pool`        | string | Which pool ran the query: `"api"`, `"worker"`, or `"replica"`.      |
| `plan`        | string | JSON-stringified output of `EXPLAIN (FORMAT JSON) <query>`, run against the same query text and bind parameters. Omitted if EXPLAIN itself fails. |

### Why plain `EXPLAIN`, not `EXPLAIN ANALYZE`

`EXPLAIN ANALYZE` re-executes the statement to gather real timing, which would duplicate side effects for mutating queries (`INSERT`/`UPDATE`/`DELETE`) every time one runs slowly. Plain `EXPLAIN` only plans the query — it never executes it — so it is safe to run unconditionally after any slow query, including writes.

### Configuration

| Variable | Default | Description |
|----------|---------|--------------|
| `SLOW_QUERY_THRESHOLD_MS` | `1000` | Minimum query duration (ms) that triggers a slow-query log entry. `0` disables slow-query logging entirely. |

### Metrics

- **`db_slow_queries_total`** (Counter, labeled by `pool`): total number of queries that exceeded the threshold.
- **`db_slow_query_duration_seconds`** (Histogram, labeled by `pool`): duration distribution of queries that exceeded the threshold.

### Example log line

```json
{
  "message": "Slow query exceeded threshold",
  "query": "SELECT * FROM attestations WHERE subject_id = $1",
  "durationMs": 1342,
  "thresholdMs": 1000,
  "pool": "api",
  "plan": "[{\"Plan\":{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"attestations\",\"Total Cost\":48123.0}}]"
}
```

## Redis Cache Key Size

`CacheService.set()` (`src/cache/redis.ts`) is the single choke point every L2 (Redis) write goes through — `attestationCacheService`, `bondCacheService`, `reputationService`, `settlementService`, `replayService`, the analytics route, and others all funnel through it. Each call serializes its value (`JSON.stringify`, or the raw string as-is) and records the resulting byte size before writing to Redis, so a single endpoint that balloons one key — for example, caching an ever-growing list/hash under one key instead of paginating — shows up immediately as an outlier instead of only being noticed when Redis memory pressure or `MEMORY USAGE` on that key becomes a problem.

### Metrics

- **`redis_key_size_bytes`** (Histogram, labeled by `namespace`): size in bytes of each value written to a Redis cache key, bucketed from 1KB to 4MB (`[1024, 4096, 16384, 65536, 262144, 1048576, 4194304]`). `namespace` is the cache namespace passed to `cache.set()` (e.g. `attestation`, `bond`, `trust`, `settlement`) — a low-cardinality label chosen deliberately over the raw key, which would blow up cardinality. A rising `redis_key_size_bytes_bucket{le="+Inf", ...}` count for a given namespace, or observations consistently landing in the top bucket, indicates that namespace's cache entries are becoming mega-keys and the caching strategy for that endpoint (e.g. paginate instead of caching the full list under one key) should be revisited.

## Outbox Publisher Observability (Issue #329)

The outbox publisher now emits structured logs via `src/utils/logger.ts` instead of `console.*`, allowing aggregation with our centralized logging.

It also exports the following Prometheus metrics to track throughput, lag, and failure rates:

- **`outbox_published_total`** (Counter): Total number of successfully published outbox events, labeled by `aggregate_type`.
- **`outbox_failed_total`** (Counter): Total number of failed outbox event publish attempts, labeled by `aggregate_type`.
- **`outbox_pending_gauge`** (Gauge): Current number of pending outbox events (lag/backlog).
- **`outbox_lease_renew_total`** (Counter): Total number of outbox events whose lease was renewed, indicating processing duration or stalls.
- **`outbox_dead_letter_total`** (Counter): Total number of outbox events moved to dead-letter, labeled by `error_code`.
- **`outbox_quarantine_total`** (Counter): Total number of outbox events moved to quarantine, labeled by `reason`.
- **`outbox_leader_acquired_total`** (Counter): Total number of times this instance acquired outbox leadership.
- **`outbox_leader_lost_total`** (Counter): Total number of times this instance lost outbox leadership.

## Timeouts & Retry Policies

Timeout events are captured in observability metrics and logs. For a comprehensive guide to configuring timeout budgets, retry policies, and operational tuning runbooks, see [`docs/timeouts-and-retries.md`](./timeouts-and-retries.md).

> **See also:** For the operator-facing index of every Prometheus metric, the
> Grafana dashboard panels, the PromQL behind every alert, and runnable
> triage queries, see [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md).
> This document focuses on tracing, log schemas, and PII redaction; it does
> not duplicate the metric catalogue.
