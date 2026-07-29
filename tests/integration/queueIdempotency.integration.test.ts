import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { IdempotentConsumer } from '../../src/services/idempotentConsumer.js'
import { IdempotencyRepository } from '../../src/db/repositories/idempotencyRepository.js'
import { QueueIdempotencyRepository } from '../../src/repositories/queueIdempotencyRepository.js'
import type { Queryable } from '../../src/db/repositories/queryable.js'

function createMockQueryable(): Queryable {
  const storage = new Map<string, any>()

  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      const normalizedSql = sql.trim()

      if (normalizedSql.includes('SELECT') && normalizedSql.includes('idempotency_keys')) {
        const key = params[0]
        const row = storage.get(key)
        if (row && new Date(row.expires_at) > new Date()) {
          return { rows: [row], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (normalizedSql.includes('INSERT INTO idempotency_keys')) {
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
        return { rows: [], rowCount: 1 }
      }

      if (normalizedSql.includes('DELETE FROM idempotency_keys')) {
        if (params.length === 1 && typeof params[0] === 'string') {
          const key = params[0]
          const existed = storage.has(key)
          storage.delete(key)
          return { rows: [], rowCount: existed ? 1 : 0 }
        }

        let deleted = 0
        const now = new Date()
        for (const [key, row] of storage.entries()) {
          if (new Date(row.expires_at) <= now) {
            storage.delete(key)
            deleted++
          }
        }
        return { rows: [], rowCount: deleted }
      }

      return { rows: [], rowCount: 0 }
    }),
  } as unknown as Queryable
}

describe('Queue Idempotency Write Layer & Consumer Integration', () => {
  let db: Queryable
  let repo: IdempotencyRepository
  let queueRepo: QueueIdempotencyRepository
  let consumer: IdempotentConsumer

  beforeEach(() => {
    db = createMockQueryable()
    repo = new IdempotencyRepository(db)
    queueRepo = new QueueIdempotencyRepository(db)
    consumer = new IdempotentConsumer(repo)
  })

  it('upserts unique keys in write layer repository', async () => {
    const key = `queue-msg-${randomUUID()}`

    await queueRepo.recordSuccess(key, { status: 'initial' })
    const firstFetch = await repo.findByKey(key)
    expect(firstFetch).not.toBeNull()
    expect(firstFetch?.responseBody).toEqual({ status: 'initial' })

    await queueRepo.recordSuccess(key, { status: 'updated' })
    const updatedFetch = await repo.findByKey(key)
    expect(updatedFetch).not.toBeNull()
    expect(updatedFetch?.responseBody).toEqual({ status: 'updated' })
  })

  it('prevents duplicate side effects under concurrent message redelivery', async () => {
    const messageId = `msg-${randomUUID()}`
    let handlerExecutions = 0

    const slowHandler = async () => {
      handlerExecutions++
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { processed: true, messageId }
    }

    const concurrentRequests = Array.from({ length: 10 }, () =>
      consumer.process(messageId, slowHandler)
    )

    const results = await Promise.all(concurrentRequests)

    expect(handlerExecutions).toBe(1)
    expect(results.every((res) => res.success === true)).toBe(true)
    expect(results.every((res) => res.result?.processed === true)).toBe(true)
  })

  it('safely handles retries on message processing failures', async () => {
    const messageId = `msg-retry-${randomUUID()}`
    let attempts = 0

    const failingThenSucceedingHandler = async () => {
      attempts++
      if (attempts === 1) {
        throw new Error('Temporary queue delivery failure')
      }
      return { status: 'recovered' }
    }

    const firstResult = await consumer.process(messageId, failingThenSucceedingHandler)
    expect(firstResult.success).toBe(false)
    expect(firstResult.error).toBe('Temporary queue delivery failure')
    expect(await consumer.isProcessed(messageId)).toBe(false)

    const secondResult = await consumer.process(messageId, failingThenSucceedingHandler)
    expect(secondResult.success).toBe(true)
    expect(secondResult.result).toEqual({ status: 'recovered' })
    expect(await consumer.isProcessed(messageId)).toBe(true)
    expect(attempts).toBe(2)
  })
})
