# Observability: Request Tracing & Metrics

To facilitate debugging in our distributed environment, every request is assigned a `Request ID` and a `Correlation ID`.

- **X-Request-ID**: Unique to every single HTTP call to this service.
- **X-Correlation-ID**: Persists across services. If an upstream service sends one, we propagate it.

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

### ESLint Rules for Validation

The project includes **two ESLint rules** that enforce schema-aware logging:

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

## Outbox Publisher Observability (Issue #329)

The outbox publisher now emits structured logs via `src/utils/logger.ts` instead of `console.*`, allowing aggregation with our centralized logging.

It also exports the following Prometheus metrics to track throughput, lag, and failure rates:

- **`outbox_published_total`** (Counter): Total number of successfully published outbox events, labeled by `aggregate_type`.
- **`outbox_failed_total`** (Counter): Total number of failed outbox event publish attempts, labeled by `aggregate_type`.
- **`outbox_pending_gauge`** (Gauge): Current number of pending outbox events (lag/backlog).
- **`outbox_lease_renew_total`** (Counter): Total number of outbox events whose lease was renewed, indicating processing duration or stalls.
- **`outbox_dead_letter_total`** (Counter): Total number of outbox events moved to dead-letter, labeled by `error_code`.
