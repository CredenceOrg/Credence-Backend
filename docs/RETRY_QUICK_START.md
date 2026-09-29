# Database Retry - Quick Start Guide

## 5-Minute Setup

### 1. Import the Retry Utility

```typescript
import { withRetryableTransaction } from '../db/retry.js'
import { pool } from '../db/pool.js'
```

### 2. Wrap Your Critical Write

```typescript
// BEFORE: No retry protection
async function updateBalance(userId: string, amount: number) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 RETURNING *',
      [amount, userId]
    )
    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// AFTER: Automatic retry on transient failures
async function updateBalance(userId: string, amount: number) {
  return await withRetryableTransaction(
    pool,
    async (client) => {
      const result = await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 RETURNING *',
        [amount, userId]
      )
      return result.rows[0]
    },
    {
      maxRetries: 3,
      operationName: `update-balance-${userId}`,
    }
  )
}
```

### 3. Move Side Effects Outside

```typescript
// ❌ WRONG: Side effects inside retry block
async function processPayment(paymentData: Payment) {
  return await withRetryableTransaction(pool, async (client) => {
    const payment = await savePayment(client, paymentData)
    
    // DANGER: Email will be sent multiple times if transaction retries!
    await sendPaymentConfirmation(payment)
    
    return payment
  }, { operationName: 'process-payment' })
}

// ✅ CORRECT: Side effects after successful commit
async function processPayment(paymentData: Payment) {
  const payment = await withRetryableTransaction(
    pool,
    async (client) => {
      // Only database operations inside retry block
      return await savePayment(client, paymentData)
    },
    { operationName: 'process-payment' }
  )
  
  // Side effects happen here, after commit
  await sendPaymentConfirmation(payment)
  
  return payment
}
```

## Common Patterns

### Pattern 1: Service Method with Retry

```typescript
export class OrderService {
  async createOrder(orderData: CreateOrderInput): Promise<Order> {
    const order = await withRetryableTransaction(
      pool,
      async (client) => {
        const { rows } = await client.query(
          'INSERT INTO orders (user_id, total, status) VALUES ($1, $2, $3) RETURNING *',
          [orderData.userId, orderData.total, 'pending']
        )
        return rows[0]
      },
      {
        maxRetries: 3,
        operationName: 'create-order',
      }
    )
    
    // Post-commit side effects
    await this.notifyWarehouse(order)
    await this.sendOrderEmail(order)
    
    return order
  }
}
```

### Pattern 2: High-Criticality Operation

```typescript
// Use more retries for critical payment operations
async function settlePayment(paymentId: string): Promise<Settlement> {
  return await withRetryableTransaction(
    pool,
    async (client) => {
      const settlement = await createSettlement(client, paymentId)
      await updatePaymentStatus(client, paymentId, 'settled')
      return settlement
    },
    {
      maxRetries: 5, // More retries for critical operations
      initialBackoffMs: 100, // Longer initial delay
      operationName: `settle-payment-${paymentId}`,
    }
  )
}
```

### Pattern 3: Idempotent Upsert

```typescript
// Use UPSERT for natural idempotency
async function recordWebhookDelivery(webhookId: string, status: string) {
  return await withRetryableTransaction(
    pool,
    async (client) => {
      const { rows } = await client.query(
        `INSERT INTO webhook_deliveries (webhook_id, status, delivered_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (webhook_id) 
         DO UPDATE SET status = $2, delivered_at = NOW()
         RETURNING *`,
        [webhookId, status]
      )
      return rows[0]
    },
    { operationName: `record-webhook-${webhookId}` }
  )
}
```

### Pattern 4: Using with Existing TransactionManager

```typescript
import { withRetryableTransactionManager } from '../db/retry.js'

// Adapter for existing TransactionManager code
const result = await withRetryableTransactionManager(
  transactionManager,
  async (client) => {
    return await repository.updateWithLock(client, data)
  },
  {
    maxRetries: 3,
    operationName: 'update-with-lock',
  }
)
```

## Configuration Options

```typescript
interface RetryOptions {
  maxRetries?: number        // Default: 3
  initialBackoffMs?: number  // Default: 50ms
  maxBackoffMs?: number      // Default: 1000ms
  operationName?: string     // Default: 'database operation'
  debugLogging?: boolean     // Default: false
}
```

### Choosing maxRetries

| Scenario | Recommended Retries | Reason |
|----------|---------------------|--------|
| Read operations | 2-3 | Quick failure, low cost |
| Standard writes | 3 (default) | Balance reliability/latency |
| Critical payments | 5-7 | High reliability priority |
| Background jobs | 5-10 | More time budget available |

## Errors You'll See

### Success Messages

```json
{
  "message": "settle-payment-abc123 succeeded after 2 retries",
  "operationName": "settle-payment-abc123",
  "attempts": 2
}
```

### Retry Attempts

```json
{
  "message": "settle-payment-abc123 attempt 2 failed, retrying after 100ms",
  "operationName": "settle-payment-abc123",
  "attempt": 2,
  "maxRetries": 3,
  "backoffMs": 100,
  "errorCode": "40001",
  "errorMessage": "could not serialize access"
}
```

### Exhausted Retries

```javascript
MaxRetriesExhaustedError: Max retries (3) exhausted for settle-payment-abc123: could not serialize access
```

## Troubleshooting

### Problem: Too Many Retries

**Symptom:** Increased latency, logs showing frequent retries

**Solution:**
```typescript
// Check for long-running transactions
// Reduce transaction scope
await withRetryableTransaction(pool, async (client) => {
  // Keep this block small and fast
  const result = await client.query('UPDATE ...')
  return result
}, options)

// Do expensive work outside transaction
const processedData = await expensiveOperation()
await withRetryableTransaction(pool, async (client) => {
  return await saveResult(client, processedData)
}, options)
```

### Problem: MaxRetriesExhaustedError

**Symptom:** Transactions failing after all retries

**Solutions:**
1. Increase `maxRetries` for the operation
2. Check for database connection pool saturation
3. Review slow queries causing lock contention
4. Consider optimistic locking patterns

### Problem: Duplicate Side Effects

**Symptom:** Multiple emails sent, duplicate API calls

**Root Cause:** Side effects inside retry block

**Fix:**
```typescript
// Move all side effects AFTER the retry block
const result = await withRetryableTransaction(pool, txnFn, options)
await externalSideEffect(result) // ← Here, not inside txnFn
```

## Testing Your Retry Logic

### Unit Test Example

```typescript
import { describe, it, expect, vi } from 'vitest'
import { withRetryableTransaction, RETRYABLE_ERROR_CODES } from '../db/retry.js'

describe('MyService', () => {
  it('should retry on serialization failure', async () => {
    const mockPool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
    }
    
    const serializationError = new Error('Serialization failure')
    ;(serializationError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE
    
    const mockFn = vi.fn()
      .mockRejectedValueOnce(serializationError)
      .mockResolvedValue('success')
    
    const result = await withRetryableTransaction(mockPool, mockFn, {
      maxRetries: 3,
      operationName: 'test',
    })
    
    expect(result).toBe('success')
    expect(mockFn).toHaveBeenCalledTimes(2) // Initial + 1 retry
  })
})
```

### Integration Test Example

```typescript
// Simulate concurrent updates
const results = await Promise.all([
  withRetryableTransaction(pool, async (client) => {
    await client.query('UPDATE accounts SET balance = balance + 100 WHERE id = 1')
  }, { operationName: 'update-1' }),
  
  withRetryableTransaction(pool, async (client) => {
    await client.query('UPDATE accounts SET balance = balance + 200 WHERE id = 1')
  }, { operationName: 'update-2' }),
])

// Both should succeed despite potential conflicts
expect(results).toHaveLength(2)
```

## Cheat Sheet

```typescript
// ✅ DO: Use for concurrent write operations
await withRetryableTransaction(pool, txnFn, { operationName: 'my-operation' })

// ✅ DO: Keep operation names descriptive
operationName: 'settle-payment-tx-abc123'

// ✅ DO: Move side effects outside retry block
const result = await withRetryableTransaction(pool, txnFn, options)
await sendEmail(result)

// ✅ DO: Use idempotent operations
INSERT ... ON CONFLICT DO UPDATE
UPDATE ... SET value = $1 WHERE id = $2
UPDATE ... SET value = $1 WHERE id = $2 AND version = $3

// ❌ DON'T: Put side effects inside retry block
await withRetryableTransaction(pool, async (client) => {
  const result = await saveData(client)
  await sendEmail(result) // ← WRONG! Will send multiple times on retry
  return result
}, options)

// ❌ DON'T: Use for non-idempotent operations
UPDATE accounts SET balance = balance + 100 // ← Can double-add on retry!

// ❌ DON'T: Use generic operation names
operationName: 'update' // ← Not helpful for debugging
operationName: 'write'  // ← Too generic
```

## Next Steps

1. ✅ Identify critical write operations in your service
2. ✅ Wrap them with `withRetryableTransaction`
3. ✅ Move side effects outside retry blocks
4. ✅ Choose appropriate `maxRetries` for each operation
5. ✅ Add unit tests for retry behavior
6. ✅ Monitor retry metrics in production

## More Information

- **Full Documentation:** `docs/DATABASE_RETRY_STRATEGY.md`
- **Implementation Details:** `src/db/retry.ts`
- **Test Examples:** `src/db/__tests__/retry.test.ts`
- **Integration Tests:** `src/db/__tests__/retry.integration.test.ts`

---

**Need Help?** Check the troubleshooting section or consult the full documentation.
