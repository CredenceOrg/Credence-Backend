# Idempotency Guard for At-Least-Once Message Processing

## Overview

The Idempotency Guard provides duplicate message detection and prevention for at-least-once queue consumers. It ensures that message handlers execute exactly once per message, even when messages are redelivered due to network failures, timeouts, or consumer restarts.

## Problem Statement

In distributed systems with at-least-once delivery semantics, the same message may be delivered multiple times:

- Network failures during acknowledgement
- Consumer crashes before completing processing
- Message broker redelivery after timeout
- Consumer restarts losing in-memory state

Without idempotency protection, duplicate deliveries can cause:

- Duplicate database records
- Double-charging in payment systems
- Incorrect state transitions
- Data inconsistencies

## Solution

The Idempotency Guard uses Redis to persist processed-message markers with TTL-based expiration:

1. **Check**: Before processing, check if message was already processed
2. **Mark**: Write marker to Redis before executing handler (fail-safe ordering)
3. **Execute**: Run the message handler
4. **Expire**: Marker automatically expires after TTL (default 24 hours)

### Key Features

- **Persistent deduplication**: Survives consumer restarts
- **TTL-based cleanup**: Automatic marker expiration prevents unbounded growth
- **Handler-scoped keys**: Different handlers can process same message independently
- **Fail-safe ordering**: Marker written before handler execution
- **Metrics integration**: Tracks duplicates as operational metrics
- **Graceful degradation**: Continues processing on Redis failures

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Message Consumer                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  1. Receive Message                                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  2. In-Memory Check (Fast Path)                       │  │
│  │     eventIdToAttestationId.has(messageId)            │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  3. Redis Check (Persistent)                          │  │
│  │     idempotencyGuard.process(...)                     │  │
│  │       ├─ EXISTS idempotency:handler:messageId         │  │
│  │       └─ If exists → Skip (duplicate)                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  4. Write Marker (Before Handler)                     │  │
│  │     SETEX idempotency:handler:messageId TTL           │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  5. Execute Handler                                    │  │
│  │     store.create(data)                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  6. Acknowledge Message                                │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Usage

### Basic Usage

```typescript
import { IdempotencyGuard } from "./lib/idempotencyGuard.js";
import { CacheService } from "./cache/redis.js";

const cache = new CacheService();
const guard = new IdempotencyGuard(cache, {
  ttlSeconds: 86400, // 24 hours
  logger: console.log,
});

// Process message idempotently
const result = await guard.process("attestation", messageId, async () => {
  // Your handler logic here
  return await store.create(data);
});

if (result.executed) {
  console.log("Processed:", result.value);
} else {
  console.log("Duplicate skipped");
}
```

### Integration with Event Listeners

```typescript
import { AttestationEventListener } from "./listeners/attestationEvents.js";
import { IdempotencyGuard } from "./lib/idempotencyGuard.js";
import { cache } from "./cache/redis.js";

const guard = new IdempotencyGuard(cache, { ttlSeconds: 86400 });

const listener = new AttestationEventListener(
  store,
  fetchEvents,
  {
    pollingInterval: 5000,
    lastCursor: "now",
    idempotencyGuard: guard, // Enable persistent deduplication
  },
  onScoreInvalidation,
);

await listener.start();
```

## Configuration

### TTL Selection

Choose TTL based on your redelivery window:

- **Short TTL (1 hour)**: Low memory usage, risk of reprocessing after TTL
- **Medium TTL (24 hours)**: Recommended default, covers most redelivery scenarios
- **Long TTL (7 days)**: Maximum protection, higher memory usage

```typescript
// Short TTL for high-volume, low-risk operations
const guard = new IdempotencyGuard(cache, { ttlSeconds: 3600 });

// Long TTL for critical financial operations
const guard = new IdempotencyGuard(cache, { ttlSeconds: 604800 });
```

### Handler Types

Use descriptive handler types to scope deduplication:

```typescript
// Different handlers can process same message independently
await guard.process("attestation:add", messageId, addHandler);
await guard.process("attestation:revoke", messageId, revokeHandler);
await guard.process("webhook:delivery", messageId, webhookHandler);
```

## Monitoring

### Metrics

The guard exposes Prometheus metrics:

```
# Total checks
idempotency_guard_checks_total{handler_type="attestation:add",result="executed"} 1000
idempotency_guard_checks_total{handler_type="attestation:add",result="duplicate"} 50

# Duplicates detected
idempotency_duplicates_detected_total{handler_type="attestation:add"} 50
```

### Runtime Metrics

```typescript
const metrics = guard.getMetrics();
console.log({
  processed: metrics.processed,
  executed: metrics.executed,
  duplicates: metrics.duplicates,
  errors: metrics.errors,
});
```

### Alerting

Set up alerts for high duplicate rates:

```yaml
# Prometheus alert rule
- alert: HighDuplicateRate
  expr: |
    rate(idempotency_duplicates_detected_total[5m]) > 10
  annotations:
    summary: High duplicate message rate detected
```

## Testing

### Unit Tests

```typescript
import { IdempotencyGuard } from "./lib/idempotencyGuard.js";

describe("IdempotencyGuard", () => {
  it("should execute handler for new message", async () => {
    const handler = vi.fn().mockResolvedValue("result");
    const result = await guard.process("test", "msg-1", handler);

    expect(result.executed).toBe(true);
    expect(result.value).toBe("result");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip handler for duplicate message", async () => {
    const handler = vi.fn().mockResolvedValue("result");

    await guard.process("test", "msg-1", handler);
    const result = await guard.process("test", "msg-1", handler);

    expect(result.executed).toBe(false);
    expect(result.isDuplicate).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
```

### Integration Tests

See `src/listeners/__tests__/attestationEventsIdempotency.test.ts` for comprehensive integration tests covering:

- Redelivery scenarios
- Marker expiration behavior
- Mixed event types
- Error handling
- Fallback behavior

## Performance Considerations

### Redis Operations

Each message requires 2 Redis operations:

1. `EXISTS` check (fast, O(1))
2. `SETEX` marker write (fast, O(1))

Expected latency: 1-5ms per message

### Memory Usage

Memory usage depends on message rate and TTL:

```
Memory = Messages/Second × TTL × Marker Size
       ≈ 1000 msg/s × 86400s × 100 bytes
       ≈ 8.6 GB
```

For high-volume systems, consider:

- Shorter TTL
- Redis cluster with sharding
- Periodic cleanup of expired keys

### Throughput

The guard adds minimal overhead:

- In-memory check: ~0.1ms
- Redis check: ~1-5ms
- Total overhead: ~1-5ms per message

For 1000 msg/s: ~1-5 seconds of Redis time per second (easily handled by single Redis instance)

## Failure Modes

### Redis Unavailable

The guard fails open on Redis errors:

```typescript
// If Redis is down, handler still executes
// Risk: Duplicate processing if message is redelivered
const result = await guard.process("handler", messageId, handler);
// result.executed = true (even if Redis check failed)
```

### Marker Write Failure

If marker write fails, handler still executes:

```typescript
// Marker write failed, but handler proceeds
// Risk: Duplicate processing on redelivery
```

### Race Conditions

Two consumers processing same message simultaneously:

```
Consumer A: EXISTS → false → SETEX → Execute
Consumer B: EXISTS → false → SETEX → Execute (duplicate!)
```

Mitigation: Use distributed locks for critical operations

## Migration Guide

### Existing Consumers

To add idempotency to existing consumers:

1. Create idempotency guard:

```typescript
const guard = new IdempotencyGuard(cache, { ttlSeconds: 86400 });
```

2. Update consumer configuration:

```typescript
const listener = new AttestationEventListener(store, fetchEvents, {
  idempotencyGuard: guard, // Add this line
});
```

3. Deploy and monitor duplicate metrics

### Backfilling Markers

For existing processed messages:

```typescript
// Mark historical messages as processed
for (const message of historicalMessages) {
  await guard.markAsProcessed("handler-type", message.id);
}
```

## Best Practices

1. **Choose appropriate TTL**: Balance memory usage vs. redelivery window
2. **Use descriptive handler types**: Enable per-handler deduplication
3. **Monitor duplicate rates**: Alert on anomalies
4. **Test redelivery scenarios**: Ensure idempotency works end-to-end
5. **Handle Redis failures**: Implement fallback strategies
6. **Document handler semantics**: Clarify idempotency guarantees
7. **Use distributed locks**: For critical operations requiring strict once-only execution

## References

- [At-Least-Once Delivery](https://en.wikipedia.org/wiki/Message_queue#Delivery_guarantees)
- [Idempotency in Distributed Systems](https://martinfowler.com/articles/patterns-of-distributed-systems/idempotent-receiver.html)
- [Redis SETEX Command](https://redis.io/commands/setex/)
- [Prometheus Metrics](https://prometheus.io/docs/concepts/metric_types/)
