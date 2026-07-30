# Deduplication Policy

This document details the deduplication key policy, table shape, and worker interaction model used in the Credence Backend. This is primarily for backend contributors and operators to understand how we achieve exactly-once processing on top of at-least-once message delivery.

## Background

Message queues (e.g. RabbitMQ, SQS, Redis Streams) guarantee at-least-once delivery, meaning consumers will occasionally receive duplicate messages due to network timeouts or application crashes. To prevent duplicate side effects (e.g., double deductions or duplicate attestations), we implement write-layer deduplication.

## Table Shape

Deduplication state is stored in PostgreSQL using the `idempotency_keys` table. 

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

### Column Definitions
- **`key`**: The unique message identifier (e.g., queue message ID, event ID, webhook delivery ID).
- **`request_hash`**: A hash of the original request used for verifying that a duplicate key indeed matches the same payload.
- **`response_code`**: HTTP-style status code (e.g., 200 for success, 500 for error).
- **`response_body`**: Cached result (for success) or error message (for failures).
- **`expires_at`**: The Time-to-Live (TTL) for automatic cleanup.
- **`created_at`**: The timestamp of when the message was first processed.

## Dedup Key Policy

When processing incoming asynchronous work, the worker generates or extracts an **idempotency key**.

1. **Extraction**: If the message contains an inherent unique identifier (e.g., a Stripe event ID, a Horizon transaction hash, or a Webhook ID), that identifier MUST be used as the `key`.
2. **Generation**: If no inherent identifier exists, a composite key should be deterministically generated, typically in the format: `[aggregate_type]:[aggregate_id]:[event_type]`.
3. **TTL Strategy**: 
   - Keys should have an `expires_at` that safely outlives the maximum queue retention and retry period.
   - The default TTL is **24 hours** (86400 seconds).

## Worker Interaction

When a worker picks up a message from a queue or receives an event, it interacts with the deduplication layer as follows:

1. **Check**: The worker queries the `idempotency_keys` table using the message's idempotency key.
2. **Bypass on Exists**: If the key exists, the worker bypasses execution. It returns the cached `response_body` and acknowledges the message back to the queue immediately.
3. **Execute**: If the key does not exist, the worker executes its core business logic.
4. **Store Result (UPSERT)**: Upon completion, the worker inserts the result (either success or failure) into the `idempotency_keys` table using an UPSERT strategy (e.g., `ON CONFLICT (key) DO UPDATE`). This guarantees that concurrent executions race safely to write the final state.
5. **Acknowledge**: Finally, the worker acknowledges the message to the queue to prevent further redeliveries.

By adhering to this model, we guarantee atomic deduplication across a distributed pool of worker nodes without requiring distributed locks (e.g., Redis).
