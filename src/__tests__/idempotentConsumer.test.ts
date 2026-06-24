import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdempotentConsumer } from '../services/idempotentConsumer.js'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import type { Queryable } from '../db/repositories/queryable.js'

interface TestContext {
  db: Queryable
  consumer: IdempotentConsumer
}

function createMockDb(): Queryable {
  const storage = new Map<string, any>()

  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('idempotency_keys')) {
        const key = params[0]
        const row = storage.get(key)
        if (row && new Date(row.expires_at) > new Date()) {
          return { rows: [row] }
        }
        return { rows: [] }
      }

      if (sql.includes('INSERT INTO idempotency_keys')) {
        const [key, actorId, requestHash, responseCode, responseBody, ttlSeconds, expiresAt] = params
        storage.set(key, {
          key,
          actor_id: actorId,
          request_hash: requestHash,
          response_code: responseCode,
          response_body: responseBody,
          ttl_seconds: ttlSeconds,
          expires_at: expiresAt,
          created_at: new Date(),
        })
        return { rowCount: 1 }
      }

      if (sql.includes('DELETE FROM idempotency_keys')) {
        let deleted = 0
        for (const [key, row] of storage.entries()) {
          if (new Date(row.expires_at) <= new Date()) {
            storage.delete(key)
            deleted++
          }
        }
        return { rowCount: deleted }
      }

      return { rows: [], rowCount: 0 }
    }),
  } as unknown as Queryable
}

describe('IdempotentConsumer', () => {
  let consumer: IdempotentConsumer
  let mockDb: Queryable

  beforeEach(() => {
    mockDb = createMockDb()
    const repo = new IdempotencyRepository(mockDb)
    consumer = new IdempotentConsumer(repo, { expiresInSeconds: 3600 })
  })

  describe('process', () => {
    it('should process new message and store result', async () => {
      const messageId = randomUUID()
      const handler = vi.fn().mockResolvedValue({ processed: true })

      const result = await consumer.process(messageId, handler)

      expect(result.success).toBe(true)
      expect(result.result).toEqual({ processed: true })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should return cached result for duplicate message', async () => {
      const messageId = randomUUID()
      const handler = vi.fn().mockResolvedValue({ processed: true })

      await consumer.process(messageId, handler)
      const cachedResult = await consumer.process(messageId, handler)

      expect(cachedResult.success).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should handle rapid sequential messages correctly', async () => {
      const messageId = randomUUID()
      const handler = vi.fn().mockResolvedValue({ processed: true })

      await consumer.process(messageId, handler)
      await consumer.process(messageId, handler)
      await consumer.process(messageId, handler)

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should store error result on failure', async () => {
      const messageId = randomUUID()
      const handler = vi.fn().mockRejectedValue(new Error('handler failed'))

      const result = await consumer.process(messageId, handler)

      expect(result.success).toBe(false)
      expect(result.error).toBe('handler failed')
    })

    it('should not retry failed message', async () => {
      const messageId = randomUUID()
      const handler = vi.fn().mockRejectedValue(new Error('handler failed'))

      await consumer.process(messageId, handler)
      const cachedResult = await consumer.process(messageId, handler)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(cachedResult.success).toBe(false)
    })
  })

  describe('isProcessed', () => {
    it('should return false for unprocessed message', async () => {
      const messageId = randomUUID()
      const processed = await consumer.isProcessed(messageId)
      expect(processed).toBe(false)
    })

    it('should return true for processed message', async () => {
      const messageId = randomUUID()
      await consumer.process(messageId, async () => ({ done: true }))
      const processed = await consumer.isProcessed(messageId)
      expect(processed).toBe(true)
    })
  })

  describe('getResult', () => {
    it('should return null for unprocessed message', async () => {
      const messageId = randomUUID()
      const result = await consumer.getResult(messageId)
      expect(result).toBeNull()
    })

    it('should return cached result', async () => {
      const messageId = randomUUID()
      await consumer.process(messageId, async () => ({ value: 42 }))
      const result = await consumer.getResult(messageId)

      expect(result).not.toBeNull()
      expect(result?.result).toEqual({ value: 42 })
    })
  })
})

describe('IdempotentConsumer with real database', () => {
  it('should integrate with IdempotencyRepository', async () => {
    const mockDb = createMockDb()
    const repo = new IdempotencyRepository(mockDb)
    const consumer = new IdempotentConsumer(repo)

    const messageId = 'queue-message-123'
    const result = await consumer.process(messageId, async () => ({
      action: 'completed',
    }))

    expect(result.success).toBe(true)
    expect(await consumer.isProcessed(messageId)).toBe(true)
  })
})