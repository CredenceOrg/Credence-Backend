# Idempotent Consumer

This document describes the idempotent consumer implementation for handling at-least-once message delivery in the Credence Backend.

## Overview

The idempotent consumer ensures that messages from queues (e.g., webhook deliveries, event listeners, background jobs) are processed exactly once even under at-least-once delivery guarantees. This prevents duplicate side effects when messages are redelivered due to consumer crashes, network timeouts, or broker retries.

## Problem Statement

Message queues (RabbitMQ, SQS, Redis streams, etc.) provide **at-least-once** delivery semantics. This means:

1. **Redelivery after crash**: If a consumer crashes after processing but before acknowledging, the message is redelivered
2. **Network timeouts**: If the acknowledgment times out, the broker redelivers the message
3. **Broker retries**: Failed messages are automatically retried by the queue
4. **Concurrent processing**: Multiple consumers may process the same message simultaneously

Without idempotency, duplicate processing leads to:
- Double deductions from user balances
- Duplicate attestations created
- Multiple notifications sent
- Inconsistent state in the database

## Solution

The implementation uses a **write-layer deduplication** approach with unique keys stored in PostgreSQL:

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Message   │────▶│  Check Database  │────▶│  Process (if    │
│   Queue     │     │  for Key exist   │     │  not seen)      │
└─────────────┘     └──────────────────┘     └─────────────────┘
                            │                        │
                            ▼                        ▼
                     ┌─────────────────────────────────────┐
                     │  Store Result (Upsert if new key)   │
                     │  - success: result                │
                     │  - failure: error                  │
                     └─────────────────────────────────────┘
```

## Architecture

### Database Schema

The existing `idempotency_keys` table stores processed message results:

```sql
CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response_code INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key columns:**
- `key`: Unique message identifier (e.g., queue message ID, event ID)
- `request_hash`: Hash of the original request for verification
- `response_code`: HTTP-style status code (200 for success, 500 for error)
- `response_body`: Cached result or error message
- `expires_at`: TTL for automatic cleanup
- `created_at`: When the message was first processed

### Class: IdempotentConsumer

Location: `src/services/idempotentConsumer.ts`

```typescript
import { IdempotentConsumer, createIdempotentConsumer } from './services/idempotentConsumer.js'
import { IdempotencyRepository } from './db/repositories/idempotencyRepository.js'

const repo = new IdempotencyRepository(pool)
const consumer = createIdempotentConsumer(repo, { expiresInSeconds: 3600 })

// Process a message
const result = await consumer.process('message-123', async () => {
    // Your business logic here
    return { processed: true }
})

if (result.success) {
    console.log(result.result)  // { processed: true }
} else {
    console.error(result.error)  // Error message if failed
}
```

## Why This Approach

### Alternatives Considered

| Approach | Pros | Cons |
|----------|------|------|
| **Write-layer dedupe (chosen)** | Simple, works with any queue, centralized | Requires DB write on every message |
| Distributed locks (Redis/ZK) | Fast check | Extra infrastructure, lock management complex |
| Client-side deduplication | No DB overhead | Not reliable, depends on client |
| Exactly-once delivery (Flink) | Cleanest semantics | Complex infrastructure |

### Why Write-Layer Deduplication

1. **Reliability**: PostgreSQL is already the system of record - using it ensures consistency
2. **Simplicity**: No additional infrastructure (Redis locks, Kafka exactly-once, etc.)
3. **Atomicity**: The UPSERT ensures only one successful processing even with concurrent consumers
4. **Auditability**: Results are stored with timestamps for debugging
5. **TTL Support**: Automatic cleanup via `expires_at` column

### Why Not Distributed Locks

- Redis locks require additional infrastructure
- Lock expiration edge cases (process dies while holding lock)
- Not durable - if lock server crashes, system becomes unavailable
- More complex failure scenarios

## Implementation Details

### Flow Diagram

```
process(messageId, handler)
         │
         ▼
    findByKey(messageId)  ──exists?──YES──▶ Return cached result
         │                                              │
         │ NO                                            │
         ▼                                              │
    handler() ──success?──NO──▶ Store error result ──▶ Return failure
         │                      │
         │ YES                  │
         ▼                     │
    Store success result ──────▶ Return success
```

### Key Methods

#### `process(messageId, handler)`

Main entry point - checks, processes, and stores result:

```typescript
async process(
    messageId: string,
    handler: () => Promise<R>
): Promise<IdempotentResult<R>>
```

**Behavior:**
1. Check if `messageId` exists in `idempotency_keys`
2. If exists → return cached result immediately
3. If not → execute handler
4. Store result (success or failure) with UPSERT
5. Return result

#### `isProcessed(messageId)`

Check if a message was already processed:

```typescript
const processed = await consumer.isProcessed('msg-123')
// Returns: true/false
```

#### `getResult(messageId)`

Retrieve cached result:

```typescript
const result = await consumer.getResult('msg-123')
// Returns: IdempotentResult or null
```

### Configuration

```typescript
const consumer = new IdempotentConsumer(repo, {
    expiresInSeconds: 86400,  // 24 hours default
})
```

- `expiresInSeconds`: How long to keep result in cache
- Default: 86400 (24 hours)
- Adjust based on queue retry policy

## Files Created

| File | Purpose |
|------|---------|
| `src/services/idempotentConsumer.ts` | Core IdempotentConsumer class |
| `src/__tests__/idempotentConsumer.test.ts` | Unit tests |
| `tests/integration/idempotentConsumer.test.ts` | Integration tests |

### Why These Files

- **idempotentConsumer.ts**: Provides reusable consumer class for any queue-backed processing
- **unit tests**: Fast feedback, tests core logic with mocks
- **integration tests**: Tests against real PostgreSQL, verifies DB constraints work

## Files Edited

| File | Change | Why |
|------|--------|-----|
| `src/db/repositories/idempotencyRepository.ts` | Added JSON parse for `responseBody` | Bug fix - JSON stored in DB wasn't being parsed when retrieved |

### Bug Fix Details

The existing `IdempotencyRepository` was storing data correctly but reading it as a string instead of parsing the JSONB back to an object:

```typescript
// Before (broken)
responseBody: row.response_body  // Returns string

// After (fixed)
responseBody: typeof row.response_body === 'string' 
    ? JSON.parse(row.response_body) 
    : row.response_body  // Returns parsed object
```

## Usage Examples

### Queue Consumer Integration

```typescript
import { createIdempotentConsumer } from './services/idempotentConsumer.js'
import { IdempotencyRepository } from './db/repositories/idempotencyRepository.js'
import { pool } from './db/pool.js'

const repo = new IdempotencyRepository(pool)
const consumer = createIdempotentConsumer(repo)

async function handleMessage(msg: { id: string; data: any }) {
    const result = await consumer.process(msg.id, async () => {
        // Process the message
        await processBondEvent(msg.data)
        return { status: 'processed' }
    })
    
    return result
}
```

### Webhook Processing

```typescript
async function processWebhook(payload: WebhookPayload) {
    const messageId = payload.id  // Unique from webhook
    
    return await consumer.process(messageId, async () => {
        const event = parseEvent(payload)
        await updateBondState(event)
        await emitAttestation(event)
        return { eventId: event.id }
    })
}
```

### Scheduled Jobs

```typescript
async function runBatchJob(jobId: string, items: Item[]) {
    const results = []
    
    for (const item of items) {
        const result = await consumer.process(
            `${jobId}:${item.id}`, 
            () => processItem(item)
        )
        results.push(result)
    }
    
    return results
}
```

## Testing

### Unit Tests

Run with:
```bash
npm test -- src/__tests__/idempotentConsumer.test.ts
```

Tests cover:
- New message processing
- Duplicate message skipping
- Sequential duplicate handling
- Error handling and storage
- Failed message caching (no retry)

### Integration Tests

Run with:
```bash
TEST_DATABASE_URL=postgres://... npm run test:integration
```

Tests verify:
- Concurrent duplicate handling
- Real database constraints
- Transaction integrity

## Performance Considerations

- **One DB round-trip per message**: Check + insert (can be combined with UPSERT)
- **Index on key**: Primary key index provides O(1) lookup
- **TTL cleanup**: Expired keys auto-cleaned by separate job
- **Connection pooling**: Uses existing PG pool

## Future Enhancements

1. **Composite keys**: Support for deduplicating based on (source, correlationId) tuple
2. **Batch processing**: Process multiple messages in single transaction
3. **Metrics**: Add histogram for processing latency
4. **Dead letter queue**: Move to DLQ after N failures

## Related Documentation

- [API Keys](api-keys.md) - Rate limiting
- [Caching](caching.md) - Redis caching layer
- [Observability](observability.md) - Metrics and tracing
- [Migration Safety](MIGRATION_SAFETY.md) - Safe migrations
- [Horizon Listener](horizon-listener.md) - Horizon event listener with validation