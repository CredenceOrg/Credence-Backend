import { describe, it, expect, vi, afterEach } from 'vitest'
import { OutboxPublisher } from './publisher.js'
import { OutboxRepository } from './repository.js'
import type { OutboxEvent } from './types.js'
import { getActiveCorrelationIds } from '../../utils/logger.js'

/**
 * These tests exercise the real `OutboxPublisher.processBatch()` →
 * `processEvent()` path (not just the emitter/repository layer) to prove
 * the correlation id captured at emit time is actually restored into the
 * tracing context for the duration of `publish()` — i.e. that a logger
 * call (or outbound webhook request) made from inside the EventPublisher
 * really does see it.
 *
 * `OutboxRepository` methods are spied on directly rather than exercised
 * against a real/pg-mem pool, since `OutboxPublisher` reads its pool from
 * a module-level singleton (`../pool.js`) that isn't easily substituted
 * per-test. This keeps the test focused on the behavior under test —
 * correlation id restoration — without depending on database wiring that
 * is already covered by the repository's own tests.
 */
function pendingEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 1n,
    aggregateType: 'bond',
    aggregateId: 'bond-1',
    eventType: 'bond.created',
    payload: { address: '0xabc' },
    status: 'processing',
    retryCount: 0,
    maxRetries: 5,
    createdAt: new Date(),
    processedAt: null,
    errorMessage: null,
    traceId: null,
    spanId: null,
    tracestate: null,
    publishIdempotencyKey: null,
    correlationId: null,
    ...overrides,
  }
}

describe('OutboxPublisher correlation id restoration during publish', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('restores the correlation id captured at emit time for the duration of publish()', async () => {
    const event = pendingEvent({ correlationId: 'corr-restored-during-publish' })

    vi.spyOn(OutboxRepository.prototype, 'claimEvents').mockResolvedValue([event])
    vi.spyOn(OutboxRepository.prototype, 'markPublished').mockResolvedValue(undefined)
    vi.spyOn(OutboxRepository.prototype, 'trySetPublishIdempotencyKey').mockResolvedValue(true)

    const seenDuringPublish: (string | undefined)[] = []
    const fakePublisher = {
      publish: async () => {
        seenDuringPublish.push(getActiveCorrelationIds().correlationId)
      },
    }

    const outboxPublisher = new OutboxPublisher(fakePublisher, { batchSize: 10, leaseSeconds: 60 })
    ;(outboxPublisher as any).running = true
    await (outboxPublisher as any).processBatch()

    expect(seenDuringPublish).toEqual(['corr-restored-during-publish'])
    // The ambient context outside processBatch is unaffected.
    expect(getActiveCorrelationIds().correlationId).toBeUndefined()
  })

  it('leaves the correlation id absent when the event never had one (background/listener-originated event)', async () => {
    const event = pendingEvent({ correlationId: null })

    vi.spyOn(OutboxRepository.prototype, 'claimEvents').mockResolvedValue([event])
    vi.spyOn(OutboxRepository.prototype, 'markPublished').mockResolvedValue(undefined)
    vi.spyOn(OutboxRepository.prototype, 'trySetPublishIdempotencyKey').mockResolvedValue(true)

    const seenDuringPublish: (string | undefined)[] = []
    const fakePublisher = {
      publish: async () => {
        seenDuringPublish.push(getActiveCorrelationIds().correlationId)
      },
    }

    const outboxPublisher = new OutboxPublisher(fakePublisher, { batchSize: 10, leaseSeconds: 60 })
    ;(outboxPublisher as any).running = true
    await (outboxPublisher as any).processBatch()

    expect(seenDuringPublish).toEqual([undefined])
  })
})
