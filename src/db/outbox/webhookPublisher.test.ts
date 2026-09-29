import { describe, it, expect, vi } from 'vitest'
import { WebhookEventPublisher } from './webhookPublisher.js'
import type { OutboxEvent } from './types.js'
import type { WebhookService } from '../../services/webhooks/service.js'

function baseEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
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
    correlationId: null,
    ...overrides,
  }
}

describe('WebhookEventPublisher', () => {
  it('forwards the correlation id captured on the outbox event to WebhookService.emit', async () => {
    const emit = vi.fn().mockResolvedValue([])
    const webhookService = { emit } as unknown as WebhookService
    const publisher = new WebhookEventPublisher(webhookService)

    await publisher.publish(baseEvent({ correlationId: 'corr-from-outbox' }))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      'bond.created',
      { address: '0xabc' },
      expect.objectContaining({ correlationId: 'corr-from-outbox' })
    )
  })

  it('passes undefined correlationId through when the outbox event has none (e.g. a listener-originated event)', async () => {
    const emit = vi.fn().mockResolvedValue([])
    const webhookService = { emit } as unknown as WebhookService
    const publisher = new WebhookEventPublisher(webhookService)

    await publisher.publish(baseEvent({ correlationId: null }))

    expect(emit).toHaveBeenCalledWith(
      'bond.created',
      { address: '0xabc' },
      expect.objectContaining({ correlationId: undefined })
    )
  })

  it('does not call WebhookService.emit for unmapped event types', async () => {
    const emit = vi.fn()
    const webhookService = { emit } as unknown as WebhookService
    const publisher = new WebhookEventPublisher(webhookService)

    await publisher.publish(baseEvent({ eventType: 'some.unmapped.event', correlationId: 'corr-1' }))

    expect(emit).not.toHaveBeenCalled()
  })
})
