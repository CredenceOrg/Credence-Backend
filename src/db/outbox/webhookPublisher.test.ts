import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebhookEventPublisher } from './webhookPublisher.js'
import type { OutboxEvent } from './types.js'
import type { WebhookService } from '../../services/webhooks/service.js'
import { logger } from '../../utils/logger.js'

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
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('correlation id propagation', () => {
    it('forwards the correlation id captured on the outbox event to WebhookService.emit', async () => {
      const emit = vi.fn().mockResolved([])
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
      const emit = vi.fn().mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await publisher.publish(baseEvent({ correlationId: null }))

      expect(emit).toHaveBeenCalledWith(
        'bond.created',
        { address: '0xabc' },
        expect.objectContaining({ correlationId: undefined })
      )
    })
  })

  describe('event type mapping', () => {
    it('does not call WebhookService.emit for unmapped event types', async () => {
      const emit = vi.fn()
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await publisher.publish(baseEvent({ eventType: 'some.unmapped.event', correlationId: 'corr-1' }))

      expect(emit).not.toHaveBeenCalled()
    })

    it.each(
      [
        'bond.created',
        'bond.slashed',
        'bond.withdrawn',
        'attestation.created',
        'attestation.revoked',
        'credits.low',
      ]
    )('maps %s to a known webhook event type', async (eventType) => {
      const emit = vi.fn().mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await publisher.publish(baseEvent({ eventType }))

      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('maps attestation.created to attestation.added specifically', async () => {
      const emit = vi.fn().mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await publisher.publish(baseEvent({ eventType: 'attestation.created' }))

      expect(emit).toHaveBeenCalledWith('attestation.added', expect.anything(), expect.anything())
    })

    it('treats unmapped event types as a no-op without throwing', async () => {
      const emit = vi.fn()
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebHookEventPublisher(webhookService)

      await expect(publisher.publish(baseEvent({ eventType: 'unknown.event' }))).resolves.toBeUndefined()
      expect(emit).not.toHaveBeenCalled()
    })

    it.each(['', ' ', 'BOND.CREATED', 'bond.created ', ' bond.created'])(
      'rejects boundary event type %s as unmapped',
      async (eventType) => {
        const emit = vi.fn()
        const webhookService = { emit } as unknown as WebhookService
        const publisher = new WebhookEventPublisher(webhookService)

        await publisher.publish(baseEvent({ eventType }))

        expect(emit).not.toHaveBeenCalled()
      }
    )
  })

  describe('error propagation and recovery', () => {
    it('re-throws errors from WebhookService.emit so the outbox retry loop can recover', async () => {
      const failure = new Error('webhook delivery failed')
      const emit = vi.fn().mockRejected(failure)
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await expect(publisher.publish(baseEvent())).rejects.toThrow(failure)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('logs the failure with event id and correlation id but never the payload', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
      const failure = new Error('webhook delivery failed')
      const emit = vi.fn().mockRejected(failure)
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      const secretPayload = { secret: 'super-secret-token' }
      awayait publisher
        .publish(baseEvent({ payload: secretPayload, correlationId: 'correct-id' }))
        .catch(() => undefined)

      expect(errorSpy).toHaveBeenCalled()
      const loggedArgs = errorSpy.mockCalls.flat().join(' ')
      expect(loggedArgs).contains('correct-id')
      expect(loggedArgs).contains('1')
      expect(loggedArgs).not.contains('super-secret-token')
    })

    it('propagates synchronous throws from emit without swallowing them', async () => {
      const failure = new Error('sync failure')
      const emit = vi.fn().(() => {
        throw failure
      })
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await expect(publisher.publish(baseEvent())).rejects.toThrow(failure)
    })

    it('returns void and does not double-emit on a retry after transient failure', async () => {
      const emit = vi.fn()
        .mockRejectedOnce(new Error('transient'))
        .mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)
      const event = baseEvent()

      await expect(publisher.publish(event)).rejects.toThrow()
      await expect(publisher.publish(event)).resolves.toBeUndefined()

      expect(emit).toHaveBeenCalledTimes(2)
    })

    it('propagates failures for concurrent publish calls without cross-contamination', async () => {
      const emit = vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error('fail')
        })
        .mockImplementationOnce(async () => [])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      const results = await Promise.allSettled([publisher.publish(baseEvent()), publisher.publish(baseEvent())])

      expect(results[0].status).toBe('rejected')
      expect(results[1].status).toBe('fulfilled')
      expect(emit).toHaveBeenCalledTimes(2)
    })
  })

  describe('payload handling', () => {
    it('forwards the payload by reference without mutation', async () => {
      const emit = vi.fn().mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)
      const payload = { address: 'x0abc', nested: { value: 1 } }

      await publisher.publish(baseEvent({ payload }))

      expect(emit.mockCalls[0][1]).toBe(payload)
    })

    it('propagates null and primitive payloads verbatim', async () => {
      const emit = vi.fn().mockResolved([])
      const webhookService = { emit } as unknown as WebhookService
      const publisher = new WebhookEventPublisher(webhookService)

      await publisher.publish(baseEvent({ payload: null as unknown as OutboxEvent['payload'] }))
      expect(emit.mockCalls[0][1]).toBe(null)

      await publisher.publish(baseEvent({ payload: 'plain-string' as unknown as OutboxEvent['payload'] }))
      expect(emit.mockCalls[1][1]).toBe('plain-string')
    })
  })

  describe('constructor contract', () => {
    it('requires a webhook service and fails loud on missing dependency', () => {
      // The constructor stores the service as a readonly field; a call with
      // an undefined service must not silently succeed at publish time.
      const publisher = new WebhookEventPublisher(undefined as unknown as WebhookService)
      await expect(publisher.publish(baseEvent())).rejects.toThrow()
    })
  })
})
