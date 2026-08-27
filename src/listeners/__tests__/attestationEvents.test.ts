import { describe, it, expect, vi, afterEach } from 'vitest'
import { AttestationEventListener } from '../attestationEvents.js'
import type { AttestationEvent, AttestationStore } from '../attestationEvents.js'
import type { Attestation } from '../../types/attestation.js'

function makeStore(): AttestationStore {
  const attestation: Attestation = {
    id: 'att-1',
    subject: 'GSUBJECT',
    verifier: 'GVERIFIER',
    weight: 80,
    claim: 'trusted',
    createdAt: new Date().toISOString(),
    revokedAt: null,
  }

  return {
    create: vi.fn().mockReturnValue(attestation),
    findById: vi.fn().mockReturnValue(undefined),
    findBySubject: vi.fn().mockReturnValue({ attestations: [], total: 0 }),
    revoke: vi.fn().mockReturnValue(undefined),
  }
}

describe('AttestationEventListener - poison message routing', () => {
  let listener: AttestationEventListener | undefined

  afterEach(() => {
    listener?.stop()
    listener = undefined
  })

  it('routes a schema-invalid event to the DLQ instead of processing it', async () => {
    const store = makeStore()
    // weight is out of the 0-100 range accepted by attestationEventSchema.
    const invalidEvent = {
      id: 'evt-1',
      pagingToken: 'pt-1',
      type: 'add',
      subject: 'GSUBJECT',
      verifier: 'GVERIFIER',
      weight: 150,
      claim: 'trusted',
      createdAt: new Date().toISOString(),
      transactionHash: 'tx-1',
    } as unknown as AttestationEvent

    const fetchEvents = vi.fn().mockResolvedValue([invalidEvent])
    const captureFailure = vi.fn().mockResolvedValue(undefined)

    listener = new AttestationEventListener(
      store,
      fetchEvents,
      { captureFailure },
      { pollingInterval: 60_000 },
    )

    await listener.start()

    expect(store.create).not.toHaveBeenCalled()
    expect(captureFailure).toHaveBeenCalledTimes(1)
    const [messageType, payload, reason] = captureFailure.mock.calls[0]
    expect(messageType).toBe('attestation')
    expect(payload).toBe(invalidEvent)
    expect(reason).toContain('SCHEMA_VALIDATION_FAILED')

    const stats = listener.getStats()
    expect(stats.errors).toBe(1)
    expect(stats.eventsProcessed).toBe(0)
  })

  it('processes a schema-valid event normally without touching the DLQ', async () => {
    const store = makeStore()
    const validEvent: AttestationEvent = {
      id: 'evt-2',
      pagingToken: 'pt-2',
      type: 'add',
      subject: 'GSUBJECT',
      verifier: 'GVERIFIER',
      weight: 80,
      claim: 'trusted',
      createdAt: new Date().toISOString(),
      transactionHash: 'tx-2',
    }

    const fetchEvents = vi.fn().mockResolvedValue([validEvent])
    const captureFailure = vi.fn().mockResolvedValue(undefined)

    listener = new AttestationEventListener(
      store,
      fetchEvents,
      { captureFailure },
      { pollingInterval: 60_000 },
    )

    await listener.start()

    expect(store.create).toHaveBeenCalledTimes(1)
    expect(captureFailure).not.toHaveBeenCalled()
    expect(listener.getStats().eventsProcessed).toBe(1)
  })

  it('loads a durable cursor and checkpoints only after processing succeeds', async () => {
    const store = makeStore()
    const validEvent: AttestationEvent = {
      id: 'evt-durable', pagingToken: 'pt-next', type: 'add', subject: 'GSUBJECT',
      verifier: 'GVERIFIER', weight: 80, claim: 'trusted',
      createdAt: new Date().toISOString(), transactionHash: 'tx-durable',
    }
    const cursorRepository = {
      findByStreamName: vi.fn().mockResolvedValue({ pagingToken: 'pt-saved' }),
      upsert: vi.fn().mockResolvedValue(undefined),
    }
    const fetchEvents = vi.fn().mockResolvedValue([validEvent])
    listener = new AttestationEventListener(
      store, fetchEvents, { captureFailure: vi.fn().mockResolvedValue(undefined) },
      { pollingInterval: 60_000, cursorRepository },
    )

    await listener.start()

    expect(fetchEvents).toHaveBeenCalledWith('pt-saved')
    expect(cursorRepository.upsert).toHaveBeenCalledWith({ streamName: 'attestation', pagingToken: 'pt-next' })
    expect(listener.getStats().lastCursor).toBe('pt-next')
  })
})
