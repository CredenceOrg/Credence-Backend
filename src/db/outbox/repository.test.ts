import { describe, it, expect, beforeEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxRepository } from './repository.js'
import { createOutboxSchema } from './schema.js'
import type { CreateOutboxEvent } from './types.js'

describe('OutboxRepository', () => {
  let db: IMemoryDb
  let pool: Pool
  let repository: OutboxRepository

  beforeEach(async () => {
    // Create fresh database for each test
    db = newDb()
    db.public.registerFunction({
      name: 'current_database',
      implementation: () => 'test',
    })
    db.public.registerFunction({
      name: 'version',
      implementation: () => 'PostgreSQL 16.0',
    })
    db.public.registerFunction({
      name: 'trim',
      args: [{ type: 'text', name: 'str' }],
      returns: 'text',
      implementation: (str: string) => str?.trim() ?? '',
    } as any)
    db.public.registerFunction({
      name: 'length',
      args: [{ type: 'text', name: 'str' }],
      returns: 'integer',
      implementation: (str: string) => str?.length ?? 0,
    } as any)
    
    const adapter = db.adapters.createPg()
    pool = new adapter.Pool() as unknown as Pool
    
    repository = new OutboxRepository()
    await createOutboxSchema(pool)
  })

  describe('create', () => {
    it('creates a new outbox event', async () => {
      const event: CreateOutboxEvent = {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc', bondedAmount: '1000' },
      }

      const id = await repository.create(pool, event)

      expect(id).toBeGreaterThan(0n)
    })

    it('sets default max retries to 5', async () => {
      const event: CreateOutboxEvent = {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      }

      const id = await repository.create(pool, event)
      const events = await repository.getByAggregate(pool, 'bond', '123')

      expect(events[0].maxRetries).toBe(5)
    })

    it('respects custom max retries', async () => {
      const event: CreateOutboxEvent = {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
        maxRetries: 3,
      }

      const id = await repository.create(pool, event)
      const events = await repository.getByAggregate(pool, 'bond', '123')

      expect(events[0].maxRetries).toBe(3)
    })
  })

  describe('fetchPendingForProcessing', () => {
    it('fetches pending events and marks them as processing', async () => {
      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      const events = await repository.fetchPendingForProcessing(pool, 10)

      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('processing')
      expect(events[0].eventType).toBe('bond.created')
    })

    it('respects batch limit', async () => {
      for (let i = 0; i < 5; i++) {
        await repository.create(pool, {
          aggregateType: 'bond',
          aggregateId: `${i}`,
          eventType: 'bond.created',
          payload: { address: `0x${i}` },
        })
      }

      const events = await repository.fetchPendingForProcessing(pool, 3)

      expect(events).toHaveLength(3)
    })

    it('skips locked events (FOR UPDATE SKIP LOCKED)', async () => {
      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      // First fetch locks the event
      const events1 = await repository.fetchPendingForProcessing(pool, 10)
      expect(events1).toHaveLength(1)

      // Second fetch should skip locked events
      const events2 = await repository.fetchPendingForProcessing(pool, 10)
      expect(events2).toHaveLength(0)
    })

    it('orders events by creation time', async () => {
      const id1 = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '1',
        eventType: 'bond.created',
        payload: { order: 1 },
      })

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10))

      const id2 = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '2',
        eventType: 'bond.created',
        payload: { order: 2 },
      })

      const events = await repository.fetchPendingForProcessing(pool, 10)

      expect(events[0].id).toBe(id1)
      expect(events[1].id).toBe(id2)
    })
  })

  describe('markPublished', () => {
    it('marks event as published with timestamp', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      await repository.markPublished(pool, id)

      const events = await repository.getByAggregate(pool, 'bond', '123')
      expect(events[0].status).toBe('published')
      expect(events[0].processedAt).toBeInstanceOf(Date)
    })
  })

  describe('markFailed', () => {
    it('increments retry count and sets error message', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
        maxRetries: 3,
      })

      await repository.fetchPendingForProcessing(pool, 1)
      await repository.markFailed(pool, id, 'Network error')

      const events = await repository.getByAggregate(pool, 'bond', '123')
      expect(events[0].status).toBe('pending')
      expect(events[0].retryCount).toBe(1)
      expect(events[0].errorMessage).toBe('Network error')
    })

    it('marks as failed when max retries exceeded', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
        maxRetries: 2,
      })

      // Fail twice
      await repository.fetchPendingForProcessing(pool, 1)
      await repository.markFailed(pool, id, 'Error 1')
      
      await repository.fetchPendingForProcessing(pool, 1)
      await repository.markFailed(pool, id, 'Error 2')

      const events = await repository.getByAggregate(pool, 'bond', '123')
      expect(events[0].status).toBe('failed')
      expect(events[0].retryCount).toBe(2)
      expect(events[0].processedAt).toBeInstanceOf(Date)
    })
  })

  describe('getByAggregate', () => {
    it('returns events for specific aggregate ordered by creation time', async () => {
      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { step: 1 },
      })

      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '456',
        eventType: 'bond.created',
        payload: { step: 2 },
      })

      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.slashed',
        payload: { step: 3 },
      })

      const events = await repository.getByAggregate(pool, 'bond', '123')

      expect(events).toHaveLength(2)
      expect(events[0].eventType).toBe('bond.slashed') // DESC order
      expect(events[1].eventType).toBe('bond.created')
    })
  })

  describe('cleanup', () => {
    it('deletes old published events', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      await repository.markPublished(pool, id)

      // Manually update processed_at to be old (use simple date arithmetic)
      await pool.query(
        `UPDATE event_outbox SET processed_at = NOW() - INTERVAL '10 days' WHERE id = $1`,
        [id.toString()]
      )

      const deletedCount = await repository.cleanup(pool, {
        publishedRetentionDays: 7,
        failedRetentionDays: 30,
      })

      expect(deletedCount).toBeGreaterThanOrEqual(1)
    })

    it('deletes old failed events', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
        maxRetries: 1,
      })

      await repository.fetchPendingForProcessing(pool, 1)
      await repository.markFailed(pool, id, 'Error')

      // Manually update processed_at to be old (use simple date arithmetic)
      await pool.query(
        `UPDATE event_outbox SET processed_at = NOW() - INTERVAL '40 days' WHERE id = $1`,
        [id.toString()]
      )

      const deletedCount = await repository.cleanup(pool, {
        publishedRetentionDays: 7,
        failedRetentionDays: 30,
      })

      expect(deletedCount).toBeGreaterThanOrEqual(1)
    })

    it('does not delete recent events', async () => {
      const id = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      await repository.markPublished(pool, id)

      const deletedCount = await repository.cleanup(pool, {
        publishedRetentionDays: 7,
        failedRetentionDays: 30,
      })

      expect(deletedCount).toBe(0)
    })
  })

  describe('getStats', () => {
    it('returns correct statistics', async () => {
      // Create pending
      await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '1',
        eventType: 'bond.created',
        payload: {},
      })

      // Create and publish
      const id2 = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '2',
        eventType: 'bond.created',
        payload: {},
      })
      await repository.markPublished(pool, id2)

      // Create and fail
      const id3 = await repository.create(pool, {
        aggregateType: 'bond',
        aggregateId: '3',
        eventType: 'bond.created',
        payload: {},
        maxRetries: 1,
      })
      await repository.fetchPendingForProcessing(pool, 1)
      await repository.markFailed(pool, id3, 'Error')

      const stats = await repository.getStats(pool)

      expect(stats.pending).toBe(1)
      expect(stats.published).toBe(1)
      expect(stats.failed).toBe(1)
    })
  })
})
