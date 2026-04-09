# Transactional Outbox Pattern

This module implements the transactional outbox pattern for reliable domain event publishing. It ensures that domain events are never lost, even when the event publishing mechanism fails.

## Problem

When publishing domain events directly after a database transaction commits, there's a race condition:

1. Transaction commits successfully
2. Application crashes before publishing event
3. Event is lost forever

This violates the guarantee that all state changes produce corresponding events.

## Solution

The transactional outbox pattern solves this by:

1. **Persisting events in the same transaction** as business state changes
2. **Publishing asynchronously** with a separate worker process
3. **Retrying failed publishes** with exponential backoff
4. **Maintaining ordering guarantees** per aggregate

## Architecture

```
┌─────────────────┐
│  Business Logic │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│   Transaction   │─────▶│ event_outbox │
│   (DB Commit)   │      │    table     │
└─────────────────┘      └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │   Outbox     │
                         │  Publisher   │
                         │   Worker     │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │   Webhook    │
                         │   Service    │
                         └──────────────┘
```

## Components

### 1. Outbox Table (`event_outbox`)

Stores domain events with metadata:

- `id`: Unique event identifier
- `aggregate_type`: Type of aggregate (e.g., "bond", "identity")
- `aggregate_id`: Aggregate instance identifier
- `event_type`: Event type (e.g., "bond.created")
- `payload`: Event data as JSONB
- `status`: Processing status (pending, processing, published, failed)
- `retry_count`: Number of publish attempts
- `max_retries`: Maximum retry attempts before marking as failed
- `created_at`: Event creation timestamp
- `processed_at`: When event was published or failed
- `error_message`: Last error message if failed

### 2. OutboxRepository

Provides database operations for outbox events:

- `create()`: Insert event in transaction
- `fetchPendingForProcessing()`: Get pending events with row-level locking
- `markPublished()`: Mark event as successfully published
- `markFailed()`: Mark event as failed and increment retry count
- `getByAggregate()`: Get events for specific aggregate (ordering)
- `cleanup()`: Remove old published/failed events
- `getStats()`: Get outbox statistics

### 3. OutboxPublisher

Background worker that polls for pending events and publishes them:

- Polls at configurable interval (default: 1 second)
- Processes events in batches (default: 100)
- Maintains ordering per aggregate
- Retries failed publishes with configurable max retries
- Cleans up old events periodically

### 4. OutboxEventEmitter

Helper for emitting events within transactions:

```typescript
await outboxEmitter.emit(db, {
  aggregateType: 'bond',
  aggregateId: '123',
  eventType: 'bond.created',
  payload: { address: '0xabc', bondedAmount: '1000' }
})
```

## Usage

### 1. Emit Events in Transactions

```typescript
import { pool } from './db/pool.js'
import { outboxEmitter } from './db/outbox/emitter.js'

async function createBond(address: string, amount: string) {
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    
    // Business logic: insert bond
    const result = await client.query(
      'INSERT INTO bonds (identity_address, amount, ...) VALUES ($1, $2, ...) RETURNING id',
      [address, amount, ...]
    )
    
    // Emit event in same transaction
    await outboxEmitter.emit(client, {
      aggregateType: 'bond',
      aggregateId: result.rows[0].id,
      eventType: 'bond.created',
      payload: { address, bondedAmount: amount }
    })
    
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
```

### 2. Start the Publisher Worker

```typescript
import { OutboxPublisher } from './db/outbox/publisher.js'
import { WebhookEventPublisher } from './db/outbox/webhookPublisher.js'
import { webhookService } from './services/webhooks/service.js'

const publisher = new OutboxPublisher(
  new WebhookEventPublisher(webhookService),
  {
    pollIntervalMs: 1000,
    batchSize: 100,
    cleanup: {
      publishedRetentionDays: 7,
      failedRetentionDays: 30
    },
    cleanupIntervalMs: 3600000 // 1 hour
  }
)

await publisher.start()
```

### 3. Configuration

Add to `.env`:

```env
OUTBOX_ENABLED=true
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_BATCH_SIZE=100
OUTBOX_PUBLISHED_RETENTION_DAYS=7
OUTBOX_FAILED_RETENTION_DAYS=30
OUTBOX_CLEANUP_INTERVAL_MS=3600000
```

## Guarantees

### At-Least-Once Delivery

Events are guaranteed to be published at least once. In rare cases (e.g., publisher crashes after publishing but before marking as published), an event may be published multiple times. Consumers should be idempotent.

### Ordering Per Aggregate

Events for the same aggregate (e.g., same bond ID) are processed in order. Events for different aggregates may be processed concurrently.

### Durability

Events are persisted in the database before the transaction commits. If the application crashes, events will be published when the publisher restarts.

## Cleanup Policy

Old events are automatically cleaned up based on retention policy:

- **Published events**: Deleted after 7 days (configurable)
- **Failed events**: Deleted after 30 days (configurable)

This prevents unbounded table growth while maintaining audit trail for recent events.

## Monitoring

Get outbox statistics:

```typescript
const stats = await publisher.getStats()
console.log(stats)
// { pending: 5, processing: 2, published: 1000, failed: 3 }
```

Monitor these metrics:

- **Pending count**: Should be low (< 100). High values indicate publisher is falling behind
- **Failed count**: Should be low. High values indicate systemic publish failures
- **Processing count**: Should be low. High values indicate slow publish operations

## Testing

The module includes comprehensive tests:

- **Unit tests** (`repository.test.ts`): Test repository operations
- **Integration tests** (`integration.test.ts`): Test end-to-end scenarios:
  - Commit success + publish failure → eventual delivery
  - Max retries → mark as failed
  - Transaction rollback → event not persisted
  - Ordering guarantees per aggregate
  - Deduplication

Run tests:

```bash
npm test src/db/outbox
```

## Migration

To add the outbox table to an existing database:

```typescript
import { createOutboxSchema } from './db/outbox/schema.js'
import { pool } from './db/pool.js'

await createOutboxSchema(pool)
```

Or use the migration:

```bash
npm run migrate
```

## Refactoring Existing Code

Replace direct event emission:

```typescript
// Before
await webhookService.emit('bond.created', { address, bondedAmount })

// After (in transaction)
await outboxEmitter.emit(db, {
  aggregateType: 'bond',
  aggregateId: bondId,
  eventType: 'bond.created',
  payload: { address, bondedAmount }
})
```

See `webhookIntegrationOutbox.ts` for a complete example.
