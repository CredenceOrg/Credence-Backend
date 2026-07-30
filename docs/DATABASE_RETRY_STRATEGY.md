# Database Retry Strategy

## Overview

This document describes the implementation of automatic retry logic for transient PostgreSQL transaction failures. The retry mechanism handles serialization failures, deadlocks, and transient connection issues with exponential backoff and full jitter.

## Problem Statement

In high-concurrency environments, database write operations can fail due to:

- **Serialization failures** (PostgreSQL error code `40001`) - Concurrent transactions conflicting on the same data
- **Deadlocks** (PostgreSQL error code `40P01`) - Two transactions waiting on each other's locks
- **Transient connection issues** (`ECONNRESET`, `ETIMEDOUT`) - Network timeouts or connection drops

Without automatic retries, these transient errors surface to users as hard failures, requiring manual retry at the application level.

## Solution Architecture

### Core Components

#### 1. Retry Utility (`src/db/retry.ts`)

The retry module provides:

- **`withRetryableTransaction`** - Wraps database transactions with automatic retry logic
- **`withRetryableTransactionManager`** - Adapter for existing `TransactionManager` code
- **`isRetryableError`** - Classifies errors as retryable or permanent
- **`calculateBackoffMs`** - Exponential backoff with full jitter calculation

#### 2. Error Classification

**Retryable Errors** (automatically retried):
- `40001` - Serialization failure
- `40P01` - Deadlock detected
- `40000` - Transaction rollback
- `40002` - Transaction integrity constraint violation
- `40003` - Transaction completion unknown
- `ECONNRESET`, `ETIMEDOUT`, etc. - Network errors

**Non-Retryable Errors** (fail fast):
- `23505` - Unique constraint violation
- `23503` - Foreign key violation
- `23502` - Not null violation
- `23514` - Check constraint violation
- `22P02` - Invalid text representation
- `22003` - Numeric value out of range
- And other data validation errors

### Exponential Backoff with Full Jitter

The retry delay uses exponential backoff with full jitter to prevent thundering herd problems:

```
delay = random(0, min(maxBackoffMs, initialBackoffMs * 2^attempt))
```

**Benefits:**
- **Exponential backoff** - Progressively longer delays reduce database load
- **Full jitter** - Random delays prevent synchronized retries across clients
- **Capped maximum** - Prevents excessively long delays

**Default Configuration:**
- `maxRetries`: 3 attempts
- `initialBackoffMs`: 50ms
- `maxBackoffMs`: 1000ms

Example delays (with 0.5 jitter):
- Attempt 1: 0-50ms (avg 25ms)
- Attempt 2: 0-100ms (avg 50ms)
- Attempt 3: 0-200ms (avg 100ms)

## Usage Guide

### Basic Usage

```typescript
import { withRetryableTransaction } from './db/retry.js'
import { pool } from './db/pool.js'

// Wrap critical write operations in retryable transaction
const result = await withRetryableTransaction(
  pool,
  async (client) => {
    // All database operations here will be retried on transient failures
    const { rows } = await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING *',
      [amount, accountId]
    )
    return rows[0]
  },
  {
    maxRetries: 3,
    operationName: 'update-account-balance',
  }
)
```

### Custom Retry Configuration

```typescript
const result = await withRetryableTransaction(
  pool,
  async (client) => {
    // Critical payment operation - use higher retry count
    return await processPayment(client, paymentData)
  },
  {
    maxRetries: 5,              // More retries for critical operations
    initialBackoffMs: 100,      // Longer initial delay
    maxBackoffMs: 2000,         // Higher maximum delay
    operationName: 'process-payment',
    debugLogging: true,         // Enable detailed retry logs
  }
)
```

### Using with TransactionManager

For existing code using `TransactionManager`, use the adapter wrapper:

```typescript
import { withRetryableTransactionManager } from './db/retry.js'

const result = await withRetryableTransactionManager(
  transactionManager,
  async (client) => {
    return await repository.criticalWrite(client, data)
  },
  {
    maxRetries: 3,
    operationName: 'critical-write',
  }
)
```

## Critical Idempotency Requirement

**⚠️ WARNING:** Functions passed to `withRetryableTransaction` MUST be idempotent.

### What is Idempotency?

An operation is idempotent if executing it multiple times produces the same result as executing it once.

**Idempotent Examples:**
```typescript
// ✅ Setting a value (always produces same result)
UPDATE accounts SET status = 'active' WHERE id = $1

// ✅ Upserting with unique constraint
INSERT INTO records (id, value) VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET value = $2

// ✅ Conditional updates with version checking
UPDATE accounts SET balance = $1, version = version + 1
WHERE id = $2 AND version = $3
```

**Non-Idempotent Examples:**
```typescript
// ❌ Incrementing without checking current value
UPDATE accounts SET balance = balance + 100 WHERE id = $1

// ❌ Appending to arrays
UPDATE records SET tags = array_append(tags, $1) WHERE id = $2
```

### Side Effects Must Occur After Commit

External side effects (emails, webhooks, API calls) MUST happen after the transaction commits successfully:

```typescript
// ✅ CORRECT: Side effects after successful commit
const order = await withRetryableTransaction(
  pool,
  async (client) => {
    // Only database operations inside retry block
    const { rows } = await client.query(
      'INSERT INTO orders (user_id, amount) VALUES ($1, $2) RETURNING *',
      [userId, amount]
    )
    return rows[0]
  },
  { operationName: 'create-order' }
)

// Side effects happen here, after commit
await sendOrderConfirmationEmail(order)
await webhookNotify(order)
await externalPaymentAPI.process(order)

// ❌ INCORRECT: Side effects inside retry block
await withRetryableTransaction(
  pool,
  async (client) => {
    const order = await createOrder(client, data)
    
    // DANGER: Email will be sent multiple times if retry occurs!
    await sendOrderConfirmationEmail(order)
    
    return order
  },
  { operationName: 'create-order' }
)
```

## Applied Services

The retry logic has been applied to the following critical services:

### 1. Settlement Service (`src/services/settlementService.ts`)
- **Operation:** `upsertSettlementStatus`
- **Reason:** Payment settlement writes under high concurrency
- **Configuration:** 3 retries, default backoff

### 2. Idempotent Consumer (`src/services/idempotentConsumer.ts`)
- **Operation:** `process`
- **Reason:** Message deduplication under concurrent processing
- **Configuration:** 3 retries, default backoff

### 3. Payment Orchestrator (`src/services/payment/orchestrator.ts`)
- **Operation:** `settlePayment`
- **Reason:** Critical payment finalization writes
- **Configuration:** 5 retries (higher for payment criticality)

## Testing

### Unit Tests (`src/db/__tests__/retry.test.ts`)

Comprehensive unit tests covering:
- ✅ Error classification (retryable vs non-retryable)
- ✅ Exponential backoff calculation with jitter
- ✅ Successful execution on first attempt
- ✅ Recovery after transient failures
- ✅ Max retries exhaustion
- ✅ Fast-fail on constraint violations
- ✅ Client release on rollback failure
- ✅ Custom retry configuration

Run with:
```bash
npm test retry.test.ts
```

### Integration Tests (`src/db/__tests__/retry.integration.test.ts`)

Real database integration tests covering:
- ✅ Serialization failure recovery
- ✅ SERIALIZABLE isolation level conflicts
- ✅ Fast-fail on unique constraints
- ✅ Fast-fail on not null violations
- ✅ Max retries exhaustion with real errors
- ✅ Idempotent operation verification
- ✅ Rollback behavior on errors
- ✅ High concurrency scenarios (20+ concurrent transactions)

Run with:
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/test npm test retry.integration.test.ts
```

### Test Coverage

Current coverage: **>90%** of retry module lines

```bash
npm run test:coverage
```

## Monitoring and Observability

### Logs

Retry attempts are automatically logged:

```json
{
  "message": "test-operation attempt 2 failed, retrying after 100ms",
  "operationName": "test-operation",
  "attempt": 2,
  "maxRetries": 3,
  "backoffMs": 100,
  "errorCode": "40001",
  "errorMessage": "could not serialize access"
}
```

Success after retries:
```json
{
  "message": "test-operation succeeded after 2 retries",
  "operationName": "test-operation",
  "attempts": 2
}
```

### Metrics

The retry mechanism integrates with existing database observability:
- Transaction duration metrics include retry time
- Span attributes track retry behavior
- Error logs capture exhausted retries

## Performance Considerations

### Latency Impact

- **Best case (no retry):** No overhead beyond transaction wrapping (~1ms)
- **Single retry:** 50-100ms average delay
- **Max retries (3):** Up to 350ms cumulative delay

### Throughput Impact

Retries consume additional:
- Database connections (one per attempt)
- Transaction slots
- CPU for backoff calculation

**Recommendation:** Monitor retry rates. If >5% of transactions retry, investigate root causes.

## Best Practices

### 1. Choose Appropriate Max Retries

- **Read-heavy operations:** 2-3 retries
- **Standard writes:** 3 retries (default)
- **Critical payments/money transfers:** 5 retries
- **Background jobs:** 5-10 retries (more time budget)

### 2. Set Meaningful Operation Names

```typescript
// ✅ GOOD: Descriptive, helps with debugging
operationName: 'settle-payment-tx-abc123'
operationName: 'update-user-balance-user-456'

// ❌ BAD: Generic, hard to trace
operationName: 'update'
operationName: 'write'
```

### 3. Handle MaxRetriesExhaustedError

```typescript
try {
  await withRetryableTransaction(pool, txnFn, options)
} catch (error) {
  if (error instanceof MaxRetriesExhaustedError) {
    // Log for investigation
    logger.error('Transaction failed after all retries', {
      operation: error.operationName,
      attempts: error.attempts,
      lastError: error.lastError,
    })
    
    // Return appropriate user-facing error
    throw new ServiceUnavailableError(
      'Service temporarily unavailable, please retry later'
    )
  }
  throw error
}
```

### 4. Optimize for Idempotency

Use database features to ensure idempotency:
- Unique constraints for deduplication
- Optimistic locking with version fields
- `INSERT ... ON CONFLICT` for upserts
- Conditional updates with `WHERE` clauses

### 5. Test Concurrency Scenarios

Add integration tests simulating real concurrency:
```typescript
const results = await Promise.all([
  withRetryableTransaction(pool, update1, options),
  withRetryableTransaction(pool, update2, options),
  withRetryableTransaction(pool, update3, options),
])
```

## Troubleshooting

### High Retry Rates

**Symptoms:** Many transactions retrying, increased latency

**Possible Causes:**
- High transaction contention on specific rows
- Long-running transactions holding locks
- Inefficient queries causing lock escalation

**Solutions:**
- Reduce transaction scope/duration
- Add database indexes to reduce lock time
- Use row-level locking strategies (`FOR UPDATE SKIP LOCKED`)
- Consider partitioning hot tables

### Max Retries Exhausted Errors

**Symptoms:** `MaxRetriesExhaustedError` appearing in logs

**Investigation Steps:**
1. Check database connection pool saturation
2. Review slow query logs for lock contention
3. Analyze transaction isolation levels
4. Look for deadlock patterns in PostgreSQL logs

**Solutions:**
- Increase `maxRetries` for affected operations
- Optimize conflicting queries
- Adjust isolation levels if appropriate
- Implement pessimistic locking where needed

### Non-Idempotent Operations Retrying

**Symptoms:** Duplicate side effects (multiple emails, double charges)

**Root Cause:** Side effects inside retry block

**Solution:** Move all side effects outside transaction:
```typescript
const result = await withRetryableTransaction(pool, dbWork, options)
// Side effects here, after successful commit
await externalSideEffect(result)
```

## Future Enhancements

Potential improvements for consideration:

1. **Adaptive Backoff** - Adjust backoff based on database load metrics
2. **Circuit Breaker** - Stop retries if database is consistently failing
3. **Retry Metrics** - Dedicated Prometheus metrics for retry rates/durations
4. **Dead Letter Queue** - Move exhausted operations to DLQ for manual review
5. **Configurable Error Codes** - Allow per-service customization of retryable errors

## References

- [PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Transaction Isolation in PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Building Resilient Services](https://docs.microsoft.com/en-us/azure/architecture/patterns/retry)

## Support

For questions or issues with the retry implementation:
1. Check this documentation
2. Review test files for usage examples
3. Check logs for retry-related messages
4. Contact the database reliability team
