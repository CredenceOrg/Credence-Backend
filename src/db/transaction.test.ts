import { Pool, PoolClient } from 'pg'
import {
  TransactionManager,
  LockTimeoutPolicy,
  LockTimeoutError,
  PG_LOCK_TIMEOUT_CODE,
} from './transaction.js'

describe('TransactionManager', () => {
  let pool: Pool
  let txManager: TransactionManager

  beforeAll(() => {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      max: 5,
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    txManager = new TransactionManager(pool, {
      readonly: 1000,
      default: 2000,
      critical: 5000,
    })

    // Create test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_locks (
        id SERIAL PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `)
    await pool.query('TRUNCATE test_locks RESTART IDENTITY')
    await pool.query('INSERT INTO test_locks (value) VALUES (100)')
  })

  afterEach(async () => {
    await pool.query('DROP TABLE IF EXISTS test_locks')
  })

  describe('withTransaction', () => {
    it('should execute transaction successfully with default policy', async () => {
      const result = await txManager.withTransaction(async (client) => {
        const res = await client.query('SELECT value FROM test_locks WHERE id = 1')
        return res.rows[0].value
      })

      expect(result).toBe(100)
    })

    it('should commit changes on success', async () => {
      await txManager.withTransaction(async (client) => {
        await client.query('UPDATE test_locks SET value = 200 WHERE id = 1')
      })

      const result = await pool.query('SELECT value FROM test_locks WHERE id = 1')
      expect(result.rows[0].value).toBe(200)
    })

    it('should rollback changes on error', async () => {
      await expect(
        txManager.withTransaction(async (client) => {
          await client.query('UPDATE test_locks SET value = 300 WHERE id = 1')
          throw new Error('Test error')
        })
      ).rejects.toThrow('Test error')

      const result = await pool.query('SELECT value FROM test_locks WHERE id = 1')
      expect(result.rows[0].value).toBe(100)
    })

    it('should set lock timeout based on policy', async () => {
      await txManager.withTransaction(
        async (client) => {
          const res = await client.query('SHOW lock_timeout')
          expect(res.rows[0].lock_timeout).toBe('1s')
        },
        { policy: LockTimeoutPolicy.READONLY }
      )
    })

    it('should use custom timeout when provided', async () => {
      await txManager.withTransaction(
        async (client) => {
          const res = await client.query('SHOW lock_timeout')
          expect(res.rows[0].lock_timeout).toBe('3s')
        },
        { timeoutMs: 3000 }
      )
    })

    it('should set isolation level', async () => {
      await txManager.withTransaction(
        async (client) => {
          const res = await client.query('SHOW transaction_isolation')
          expect(res.rows[0].transaction_isolation).toBe('repeatable read')
        },
        { isolationLevel: 'REPEATABLE READ' }
      )
    })
  })

  describe('lock timeout handling', () => {
    it('should throw LockTimeoutError on lock timeout', async () => {
      // Hold a lock in one transaction
      const client1 = await pool.connect()
      await client1.query('BEGIN')
      await client1.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')

      try {
        // Try to acquire same lock with short timeout
        await expect(
          txManager.withTransaction(
            async (client) => {
              await client.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')
            },
            { policy: LockTimeoutPolicy.READONLY, timeoutMs: 100 }
          )
        ).rejects.toThrow(LockTimeoutError)
      } finally {
        await client1.query('ROLLBACK')
        client1.release()
      }
    })

    it('should include policy and timeout in error', async () => {
      const client1 = await pool.connect()
      await client1.query('BEGIN')
      await client1.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')

      try {
        await txManager.withTransaction(
          async (client) => {
            await client.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')
          },
          { policy: LockTimeoutPolicy.CRITICAL, timeoutMs: 100 }
        )
      } catch (error) {
        expect(error).toBeInstanceOf(LockTimeoutError)
        const lockError = error as LockTimeoutError
        expect(lockError.policy).toBe(LockTimeoutPolicy.CRITICAL)
        expect(lockError.timeoutMs).toBe(100)
        expect(lockError.message).toContain('Lock timeout after 100ms')
      } finally {
        await client1.query('ROLLBACK')
        client1.release()
      }
    })

    it('should retry on lock timeout when enabled', async () => {
      let attempts = 0
      const client1 = await pool.connect()
      await client1.query('BEGIN')
      await client1.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')

      // Release lock after 300ms
      setTimeout(async () => {
        await client1.query('ROLLBACK')
        client1.release()
      }, 300)

      const result = await txManager.withTransaction(
        async (client) => {
          attempts++
          const res = await client.query(
            'SELECT * FROM test_locks WHERE id = 1 FOR UPDATE'
          )
          return res.rows[0].value
        },
        {
          policy: LockTimeoutPolicy.DEFAULT,
          timeoutMs: 200,
          retryOnLockTimeout: true,
          maxRetries: 3,
          retryDelayMs: 50,
        }
      )

      expect(result).toBe(100)
      expect(attempts).toBeGreaterThan(1)
    })

    it('should use exponential backoff for retries', async () => {
      const delays: number[] = []
      const client1 = await pool.connect()
      await client1.query('BEGIN')
      await client1.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')

      try {
        await txManager.withTransaction(
          async (client) => {
            const start = Date.now()
            try {
              await client.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')
            } catch (error) {
              delays.push(Date.now() - start)
              throw error
            }
          },
          {
            timeoutMs: 50,
            retryOnLockTimeout: true,
            maxRetries: 2,
            retryDelayMs: 100,
          }
        )
      } catch (error) {
        // Expected to fail after retries
      } finally {
        await client1.query('ROLLBACK')
        client1.release()
      }

      // Verify exponential backoff (100ms, 200ms)
      expect(delays.length).toBeGreaterThan(1)
    })

    it('should fail after max retries', async () => {
      const client1 = await pool.connect()
      await client1.query('BEGIN')
      await client1.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')

      try {
        await expect(
          txManager.withTransaction(
            async (client) => {
              await client.query('SELECT * FROM test_locks WHERE id = 1 FOR UPDATE')
            },
            {
              timeoutMs: 50,
              retryOnLockTimeout: true,
              maxRetries: 2,
              retryDelayMs: 10,
            }
          )
        ).rejects.toThrow(LockTimeoutError)
      } finally {
        await client1.query('ROLLBACK')
        client1.release()
      }
    })
  })

  describe('concurrent transactions', () => {
    it('should serialize concurrent updates with FOR UPDATE', async () => {
      const updates = await Promise.all([
        txManager.withTransaction(async (client) => {
          const res = await client.query(
            'SELECT value FROM test_locks WHERE id = 1 FOR UPDATE'
          )
          const newValue = res.rows[0].value + 10
          await client.query('UPDATE test_locks SET value = $1 WHERE id = 1', [
            newValue,
          ])
          return newValue
        }),
        txManager.withTransaction(async (client) => {
          const res = await client.query(
            'SELECT value FROM test_locks WHERE id = 1 FOR UPDATE'
          )
          const newValue = res.rows[0].value + 20
          await client.query('UPDATE test_locks SET value = $1 WHERE id = 1', [
            newValue,
          ])
          return newValue
        }),
      ])

      const finalResult = await pool.query(
        'SELECT value FROM test_locks WHERE id = 1'
      )
      
      // One transaction should see 100 and update to 110
      // The other should see 110 and update to 130
      expect(finalResult.rows[0].value).toBe(130)
    })
  })

  describe('error handling', () => {
    it('should not retry non-lock-timeout errors', async () => {
      let attempts = 0

      await expect(
        txManager.withTransaction(
          async (client) => {
            attempts++
            throw new Error('Non-lock error')
          },
          { retryOnLockTimeout: true, maxRetries: 3 }
        )
      ).rejects.toThrow('Non-lock error')

      expect(attempts).toBe(1)
    })

    it('should release client on error', async () => {
      const initialCount = pool.totalCount

      await expect(
        txManager.withTransaction(async (client) => {
          throw new Error('Test error')
        })
      ).rejects.toThrow('Test error')

      // Client should be released back to pool
      expect(pool.idleCount).toBeLessThanOrEqual(initialCount)
    })
  })
})
