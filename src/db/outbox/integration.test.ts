import { describe, it, expect, beforeEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxRepository } from './repository.js'
import { OutboxPublisher, type EventPublisher } from './publisher.js'
import { outboxEmitter } from './emitter.js'
import { createOutboxSchema } from './schema.js'
import type { OutboxEvent } from './types.js'

describe('Outbox Integration Tests', () => {
  let db: IMemoryDb
  let pool: Pool
  let repository: OutboxRepository

  beforeEach(async () => {
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

  describe('Commit success + publish failure scenario', () => {
    it('persists event even when publish fails, then retries', async () => {
      let publishAttempts = 0
      const mockPublisher: EventPublisher = {
        publish: vi.fn(async (event: OutboxEvent) => {
          publishAttempts++
          if (publishAttempts === 1) {
            throw new Error('Network timeout')
          }
          // Succeed on second attempt
        }),
      }

      // Simulate business transaction
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Business logic: create a bond
        // (simplified - just emit event)
        await outboxEmitter.emit(client, {
          aggregateType: 'bond',
          aggregateId: '123',
          eventType: 'bond.created',
          payload: { address: '0xabc', bondedAmount: '1000' },
        })

        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      // Verify event is persisted
      const events = await repository.getByAggregate(pool, 'bond', '123')
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('pending')

      // Start publisher
      const publisher = new OutboxPublisher(mockPublisher, {
        pollIntervalMs: 100,
        batchSize: 10,
        cleanupIntervalMs: 3600000,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      })

      await publisher.start()

      // Wait for first attempt (will fail)
      await new Promise(resolve => setTimeout(resolve, 200))

      // Verify event is marked for retry
      const eventsAfterFail = await repository.getByAggregate(pool, 'bond', '123')
      expect(eventsAfterFail[0].status).toBe('pending')
      expect(eventsAfterFail[0].retryCount).toBe(1)

      // Wait for retry (will succeed)
      await new Promise(resolve => setTimeout(resolve, 200))

      // Verify event is published
      const eventsAfterSuccess = await repository.getByAggregate(pool, 'bond', '123')
      expect(eventsAfterSuccess[0].status).toBe('published')
      expect(publishAttempts).toBe(2)

      await publisher.stop()
    })

    it('marks event as failed after max retries', async () => {
      const mockPublisher: EventPublisher = {
        publish: vi.fn(async () => {
          throw new Error('Permanent failure')
        }),
      }

      // Create event with low max retries
      await outboxEmitter.emit(pool, {
        aggregateType: 'bond',
        aggregateId: '456',
        eventType: 'bond.created',
        payload: { address: '0xdef' },
        maxRetries: 2,
      })

      const publisher = new OutboxPublisher(mockPublisher, {
        pollIntervalMs: 100,
        batchSize: 10,
        cleanupIntervalMs: 3600000,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      })

      await publisher.start()

      // Wait for all retries
      await new Promise(resolve => setTimeout(resolve, 500))

      const events = await repository.getByAggregate(pool, 'bond', '456')
      expect(events[0].status).toBe('failed')
      expect(events[0].retryCount).toBe(2)
      expect(events[0].errorMessage).toContain('Permanent failure')

      await publisher.stop()
    })
  })

  describe('Eventual delivery guarantee', () => {
    it('delivers all events eventually despite transient failures', async () => {
      const deliveredEvents: OutboxEvent[] = []
      let failureCount = 0

      const mockPublisher: EventPublisher = {
        publish: vi.fn(async (event: OutboxEvent) => {
          // Fail first 3 attempts, then succeed
          if (failureCount < 3) {
            failureCount++
            throw new Error('Transient failure')
          }
          deliveredEvents.push(event)
        }),
      }

      // Create multiple events
      for (let i = 0; i < 3; i++) {
        await outboxEmitter.emit(pool, {
          aggregateType: 'bond',
          aggregateId: `${i}`,
          eventType: 'bond.created',
          payload: { address: `0x${i}` },
        })
      }

      const publisher = new OutboxPublisher(mockPublisher, {
        pollIntervalMs: 100,
        batchSize: 10,
        cleanupIntervalMs: 3600000,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      })

      await publisher.start()

      // Wait for eventual delivery
      await new Promise(resolve => setTimeout(resolve, 1000))

      expect(deliveredEvents).toHaveLength(3)
      expect(deliveredEvents.map(e => e.aggregateId).sort()).toEqual(['0', '1', '2'])

      await publisher.stop()
    })
  })

  describe('Ordering guarantees per aggregate', () => {
    it('processes events for same aggregate in order', async () => {
      const processedEvents: OutboxEvent[] = []

      const mockPublisher: EventPublisher = {
        publish: vi.fn(async (event: OutboxEvent) => {
          processedEvents.push(event)
        }),
      }

      // Create multiple events for same aggregate
      await outboxEmitter.emit(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { step: 1 },
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      await outboxEmitter.emit(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.slashed',
        payload: { step: 2 },
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      await outboxEmitter.emit(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.withdrawn',
        payload: { step: 3 },
      })

      const publisher = new OutboxPublisher(mockPublisher, {
        pollIntervalMs: 100,
        batchSize: 10,
        cleanupIntervalMs: 3600000,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      })

      await publisher.start()
      await new Promise(resolve => setTimeout(resolve, 300))

      expect(processedEvents).toHaveLength(3)
      expect((processedEvents[0].payload as any).step).toBe(1)
      expect((processedEvents[1].payload as any).step).toBe(2)
      expect((processedEvents[2].payload as any).step).toBe(3)

      await publisher.stop()
    })
  })

  describe('Transaction rollback scenario', () => {
    it('does not persist event when transaction rolls back', async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Emit event
        await outboxEmitter.emit(client, {
          aggregateType: 'bond',
          aggregateId: '999',
          eventType: 'bond.created',
          payload: { address: '0xrollback' },
        })

        // Simulate business logic failure
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }

      // Verify event was not persisted
      const events = await repository.getByAggregate(pool, 'bond', '999')
      expect(events).toHaveLength(0)
    })
  })

  describe('Deduplication', () => {
    it('does not process same event twice', async () => {
      let publishCount = 0

      const mockPublisher: EventPublisher = {
        publish: vi.fn(async () => {
          publishCount++
        }),
      }

      await outboxEmitter.emit(pool, {
        aggregateType: 'bond',
        aggregateId: '123',
        eventType: 'bond.created',
        payload: { address: '0xabc' },
      })

      const publisher = new OutboxPublisher(mockPublisher, {
        pollIntervalMs: 100,
        batchSize: 10,
        cleanupIntervalMs: 3600000,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      })

      await publisher.start()
      await new Promise(resolve => setTimeout(resolve, 500))

      // Event should be published exactly once
      expect(publishCount).toBe(1)

      const events = await repository.getByAggregate(pool, 'bond', '123')
      expect(events[0].status).toBe('published')

      await publisher.stop()
    })
  })
})
