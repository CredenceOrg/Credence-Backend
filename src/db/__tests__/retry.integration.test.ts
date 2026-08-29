import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import {
  withRetryableTransaction,
  isRetryableError,
  MaxRetriesExhaustedError,
  RETRYABLE_ERROR_CODES,
} from '../retry.js'

/**
 * Integration tests for retry logic against a real PostgreSQL database.
 * 
 * These tests simulate actual concurrent transaction scenarios that can occur
 * in production (serialization failures, deadlocks, etc.).
 * 
 * To run these tests, ensure you have a PostgreSQL database available and
 * set the DATABASE_URL environment variable.
 * 
 * Example:
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/test npm test retry.integration.test.ts
 */

// Skip these tests if no database is configured
const shouldSkip = !process.env.DATABASE_URL && !process.env.DB_URL
const describeDb = shouldSkip ? describe.skip : describe

describeDb('retry integration tests', () => {
  let pool: Pool
  let testTableName: string

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || process.env.DB_URL
    if (!dbUrl) {
      throw new Error('DATABASE_URL or DB_URL must be set for integration tests')
    }

    pool = new Pool({
      connectionString: dbUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })

    // Create a unique test table for this test run
    testTableName = `test_retry_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${testTableName} (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL UNIQUE,
        balance BIGINT NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
  })

  afterAll(async () => {
    // Clean up test table
    if (pool && testTableName) {
      await pool.query(`DROP TABLE IF EXISTS ${testTableName}`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    // Clear test data before each test
    await pool.query(`TRUNCATE ${testTableName} RESTART IDENTITY CASCADE`)
  })

  describe('serialization failure scenarios', () => {
    it('should retry and recover from serialization failure', async () => {
      // Insert initial test data
      await pool.query(`
        INSERT INTO ${testTableName} (account_id, balance, version)
        VALUES (1, 1000, 0)
      `)

      // Simulate concurrent updates that cause serialization failures
      const results = await Promise.all([
        withRetryableTransaction(
          pool,
          async (client) => {
            const { rows } = await client.query(
              `SELECT balance, version FROM ${testTableName} WHERE account_id = $1`,
              [1]
            )
            const current = rows[0]
            
            // Simulate some processing time to increase conflict likelihood
            await new Promise((resolve) => setTimeout(resolve, 10))
            
            await client.query(
              `UPDATE ${testTableName} 
               SET balance = $1, version = $2, updated_at = CURRENT_TIMESTAMP 
               WHERE account_id = $3 AND version = $4`,
              [current.balance + 100, current.version + 1, 1, current.version]
            )
            
            return current.balance + 100
          },
          {
            maxRetries: 5,
            initialBackoffMs: 10,
            operationName: 'concurrent-update-1',
          }
        ),
        withRetryableTransaction(
          pool,
          async (client) => {
            const { rows } = await client.query(
              `SELECT balance, version FROM ${testTableName} WHERE account_id = $1`,
              [1]
            )
            const current = rows[0]
            
            await new Promise((resolve) => setTimeout(resolve, 10))
            
            await client.query(
              `UPDATE ${testTableName} 
               SET balance = $1, version = $2, updated_at = CURRENT_TIMESTAMP 
               WHERE account_id = $3 AND version = $4`,
              [current.balance + 200, current.version + 1, 1, current.version]
            )
            
            return current.balance + 200
          },
          {
            maxRetries: 5,
            initialBackoffMs: 10,
            operationName: 'concurrent-update-2',
          }
        ),
      ])

      // Both transactions should complete successfully
      expect(results).toHaveLength(2)
      
      // Final balance should reflect both updates
      const { rows } = await pool.query(
        `SELECT balance FROM ${testTableName} WHERE account_id = 1`
      )
      expect(rows[0].balance).toBe('1300') // 1000 + 100 + 200
    })

    it('should handle SERIALIZABLE isolation level conflicts', async () => {
      await pool.query(`
        INSERT INTO ${testTableName} (account_id, balance)
        VALUES (1, 5000), (2, 5000)
      `)

      // Two transactions that read and update different rows
      // In SERIALIZABLE mode, this can cause conflicts
      const transfer = async (fromId: number, toId: number, amount: number) => {
        return await withRetryableTransaction(
          pool,
          async (client) => {
            await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
            
            // Read balances
            const fromResult = await client.query(
              `SELECT balance FROM ${testTableName} WHERE account_id = $1`,
              [fromId]
            )
            const toResult = await client.query(
              `SELECT balance FROM ${testTableName} WHERE account_id = $1`,
              [toId]
            )
            
            const fromBalance = parseInt(fromResult.rows[0].balance)
            const toBalance = parseInt(toResult.rows[0].balance)
            
            if (fromBalance < amount) {
              throw new Error('Insufficient funds')
            }
            
            // Simulate processing delay
            await new Promise((resolve) => setTimeout(resolve, 5))
            
            // Update balances
            await client.query(
              `UPDATE ${testTableName} SET balance = $1 WHERE account_id = $2`,
              [fromBalance - amount, fromId]
            )
            await client.query(
              `UPDATE ${testTableName} SET balance = $1 WHERE account_id = $2`,
              [toBalance + amount, toId]
            )
            
            return { fromId, toId, amount }
          },
          {
            maxRetries: 5,
            initialBackoffMs: 20,
            operationName: `transfer-${fromId}-to-${toId}`,
          }
        )
      }

      // Execute concurrent transfers
      const results = await Promise.all([
        transfer(1, 2, 1000),
        transfer(2, 1, 500),
      ])

      expect(results).toHaveLength(2)
      
      // Verify final balances
      const { rows } = await pool.query(
        `SELECT account_id, balance FROM ${testTableName} ORDER BY account_id`
      )
      
      // Account 1: 5000 - 1000 + 500 = 4500
      expect(rows[0].balance).toBe('4500')
      // Account 2: 5000 + 1000 - 500 = 5500
      expect(rows[1].balance).toBe('5500')
    })
  })

  describe('non-retryable error scenarios', () => {
    it('should fail fast on unique constraint violation', async () => {
      await pool.query(`
        INSERT INTO ${testTableName} (account_id, balance)
        VALUES (1, 1000)
      `)

      await expect(
        withRetryableTransaction(
          pool,
          async (client) => {
            await client.query(`
              INSERT INTO ${testTableName} (account_id, balance)
              VALUES (1, 2000)
            `)
          },
          {
            maxRetries: 3,
            operationName: 'duplicate-insert',
          }
        )
      ).rejects.toThrow(/duplicate key value/)

      // Should only attempt once (no retries on constraint violations)
    })

    it('should fail fast on not null constraint violation', async () => {
      await expect(
        withRetryableTransaction(
          pool,
          async (client) => {
            await client.query(`
              INSERT INTO ${testTableName} (balance)
              VALUES (1000)
            `)
          },
          {
            maxRetries: 3,
            operationName: 'null-constraint',
          }
        )
      ).rejects.toThrow(/null value/)
    })
  })

  describe('max retries exhaustion', () => {
    it('should throw MaxRetriesExhaustedError after exhausting retries', async () => {
      // Create a scenario that consistently fails with a retryable error
      let attemptCount = 0

      try {
        await withRetryableTransaction(
          pool,
          async (client) => {
            attemptCount++
            
            // Force a serialization failure by querying a non-existent row
            // with SERIALIZABLE isolation
            await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
            await client.query(`
              SELECT * FROM ${testTableName} WHERE account_id = 999999 FOR UPDATE
            `)
            
            // Simulate a conflict that causes serialization failure
            // In a real scenario, this would be caused by concurrent transactions
            const error = new Error('could not serialize access')
            ;(error as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE
            throw error
          },
          {
            maxRetries: 2,
            initialBackoffMs: 5,
            operationName: 'forced-failure',
          }
        )
        
        // Should not reach here
        expect.fail('Should have thrown MaxRetriesExhaustedError')
      } catch (error) {
        expect(error).toBeInstanceOf(MaxRetriesExhaustedError)
        expect((error as MaxRetriesExhaustedError).attempts).toBe(2)
        // Initial attempt + 2 retries = 3 total attempts
        expect(attemptCount).toBe(3)
      }
    })
  })

  describe('idempotency verification', () => {
    it('should safely retry idempotent operations', async () => {
      await pool.query(`
        INSERT INTO ${testTableName} (account_id, balance)
        VALUES (1, 1000)
      `)

      let executionCount = 0
      
      const result = await withRetryableTransaction(
        pool,
        async (client) => {
          executionCount++
          
          // Idempotent operation: set balance to a specific value
          await client.query(`
            UPDATE ${testTableName}
            SET balance = 5000
            WHERE account_id = 1
          `)
          
          const { rows } = await client.query(
            `SELECT balance FROM ${testTableName} WHERE account_id = 1`
          )
          
          return parseInt(rows[0].balance)
        },
        {
          maxRetries: 3,
          operationName: 'idempotent-update',
        }
      )

      expect(result).toBe(5000)
      expect(executionCount).toBe(1) // Should succeed on first try
      
      // Verify final state
      const { rows } = await pool.query(
        `SELECT balance FROM ${testTableName} WHERE account_id = 1`
      )
      expect(rows[0].balance).toBe('5000')
    })
  })

  describe('rollback behavior', () => {
    it('should rollback on error and not commit partial changes', async () => {
      await pool.query(`
        INSERT INTO ${testTableName} (account_id, balance)
        VALUES (1, 1000)
      `)

      try {
        await withRetryableTransaction(
          pool,
          async (client) => {
            // Make a change
            await client.query(`
              UPDATE ${testTableName}
              SET balance = 2000
              WHERE account_id = 1
            `)
            
            // Then throw a non-retryable error
            throw new Error('Simulated business logic error')
          },
          {
            maxRetries: 3,
            operationName: 'rollback-test',
          }
        )
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }

      // Verify the change was rolled back
      const { rows } = await pool.query(
        `SELECT balance FROM ${testTableName} WHERE account_id = 1`
      )
      expect(rows[0].balance).toBe('1000') // Original value preserved
    })
  })

  describe('high concurrency scenarios', () => {
    it('should handle multiple concurrent transactions with retries', async () => {
      // Insert test accounts
      for (let i = 1; i <= 10; i++) {
        await pool.query(`
          INSERT INTO ${testTableName} (account_id, balance)
          VALUES ($1, 1000)
        `, [i])
      }

      // Simulate 20 concurrent updates
      const updates = Array.from({ length: 20 }, (_, i) => {
        const accountId = (i % 10) + 1
        return withRetryableTransaction(
          pool,
          async (client) => {
            const { rows } = await client.query(
              `SELECT balance FROM ${testTableName} WHERE account_id = $1`,
              [accountId]
            )
            
            const newBalance = parseInt(rows[0].balance) + 50
            
            await client.query(
              `UPDATE ${testTableName} SET balance = $1 WHERE account_id = $2`,
              [newBalance, accountId]
            )
            
            return newBalance
          },
          {
            maxRetries: 5,
            initialBackoffMs: 10,
            operationName: `concurrent-update-${i}`,
          }
        )
      })

      const results = await Promise.all(updates)
      expect(results).toHaveLength(20)

      // Verify each account received 2 updates of +50
      const { rows } = await pool.query(
        `SELECT balance FROM ${testTableName} ORDER BY account_id`
      )
      
      rows.forEach((row) => {
        expect(row.balance).toBe('1100') // 1000 + 50 + 50
      })
    })
  })
})
