import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  AttestationEventListener,
  type AttestationEvent,
  type AttestationStore,
  type EventFetcher,
} from './attestationEvents.js'
import { AttestationRepository } from '../repositories/attestationRepository.js'

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeAddEvent(overrides: Partial<AttestationEvent> = {}): AttestationEvent {
  return {
    id: overrides.id ?? 'evt-1',
    pagingToken: overrides.pagingToken ?? 'cursor-1',
    type: 'add',
    subject: overrides.subject ?? 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    verifier: overrides.verifier ?? 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    weight: overrides.weight ?? 80,
    claim: overrides.claim ?? 'KYC verified',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    transactionHash: overrides.transactionHash ?? 'tx-hash-1',
  }
}

function makeRevokeEvent(overrides: Partial<AttestationEvent> = {}): AttestationEvent {
  return {
    ...makeAddEvent(overrides),
    id: overrides.id ?? 'evt-revoke-1',
    pagingToken: overrides.pagingToken ?? 'cursor-revoke-1',
    type: 'revoke',
    claim: overrides.claim ?? '',
    weight: overrides.weight ?? 0,
  }
}

function createMockFetcher(events: AttestationEvent[]): EventFetcher {
  let called = false
  return async (_cursor: string) => {
    if (!called) {
      called = true
      return events
    }
    return []
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('AttestationEventListener', () => {
  let store: AttestationRepository
  let listener: AttestationEventListener

  beforeEach(() => {
    store = new AttestationRepository()
    vi.useFakeTimers()
  })

  afterEach(() => {
    listener?.stop()
    vi.useRealTimers()
  })

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should start and become active', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      expect(listener.isActive()).toBe(false)
      await listener.start()
      expect(listener.isActive()).toBe(true)
    })

    it('should stop and become inactive', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      await listener.start()
      listener.stop()
      expect(listener.isActive()).toBe(false)
    })

    it('should be idempotent on double start', async () => {
      const fetcher = vi.fn(async () => []) as EventFetcher
      listener = new AttestationEventListener(store, fetcher)

      await listener.start()
      await listener.start()
      // Should only have polled once (second start is a no-op)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })
  })

  // ── Add events ─────────────────────────────────────────────────────

  describe('add events', () => {
    it('should create an attestation from an add event', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      const event = makeAddEvent()
      const result = await listener.processEvent(event)

      expect(result).toBe(event.subject)
      expect(store.size).toBe(1)

      const { attestations } = store.findBySubject(event.subject)
      expect(attestations).toHaveLength(1)
      expect(attestations[0].verifier).toBe(event.verifier)
      expect(attestations[0].weight).toBe(80)
      expect(attestations[0].claim).toBe('KYC verified')
    })

    it('should process multiple add events for different subjects', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      await listener.processEvent(makeAddEvent({ id: 'evt-1', subject: 'SUBJECT_A' }))
      await listener.processEvent(makeAddEvent({ id: 'evt-2', subject: 'SUBJECT_B' }))
      await listener.processEvent(makeAddEvent({ id: 'evt-3', subject: 'SUBJECT_C' }))

      expect(store.size).toBe(3)
      expect(store.countBySubject('SUBJECT_A')).toBe(1)
      expect(store.countBySubject('SUBJECT_B')).toBe(1)
      expect(store.countBySubject('SUBJECT_C')).toBe(1)
    })

    it('should process multiple add events for the same subject from different verifiers', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      await listener.processEvent(makeAddEvent({ id: 'evt-1', verifier: 'VERIFIER_A' }))
      await listener.processEvent(makeAddEvent({ id: 'evt-2', verifier: 'VERIFIER_B' }))

      const { attestations } = store.findBySubject(
        'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
      )
      expect(attestations).toHaveLength(2)
    })
  })

  // ── Revoke events ──────────────────────────────────────────────────

  describe('revoke events', () => {
    it('should revoke an existing attestation', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      const addEvent = makeAddEvent()
      await listener.processEvent(addEvent)

      const revokeEvent = makeRevokeEvent({
        subject: addEvent.subject,
        verifier: addEvent.verifier,
      })
      const result = await listener.processEvent(revokeEvent)

      expect(result).toBe(addEvent.subject)

      // Should be revoked — not in default (non-revoked) list
      const { attestations } = store.findBySubject(addEvent.subject)
      expect(attestations).toHaveLength(0)

      // But should still exist with includeRevoked
      const { attestations: all } = store.findBySubject(addEvent.subject, {
        includeRevoked: true,
      })
      expect(all).toHaveLength(1)
      expect(all[0].revokedAt).not.toBeNull()
    })

    it('should handle revoke for non-existent attestation gracefully', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      const revokeEvent = makeRevokeEvent({ subject: 'UNKNOWN_SUBJECT' })
      const result = await listener.processEvent(revokeEvent)

      // Still processed (recorded in stats), just no attestation to revoke
      expect(result).toBe('UNKNOWN_SUBJECT')
      expect(listener.getStats().revokeEvents).toBe(1)
    })
  })

  // ── Duplicate handling ─────────────────────────────────────────────

  describe('duplicate handling', () => {
    it('should skip duplicate add events', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      const event = makeAddEvent({ id: 'same-id' })
      await listener.processEvent(event)
      await listener.processEvent(event) // duplicate

      expect(store.size).toBe(1)
      expect(listener.getStats().duplicatesSkipped).toBe(1)
    })

    it('should skip duplicate revoke events', async () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      // Add then revoke
      await listener.processEvent(makeAddEvent({ id: 'add-1' }))
      await listener.processEvent(
        makeRevokeEvent({
          id: 'revoke-1',
          subject: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
          verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      )

      // Duplicate revoke
      await listener.processEvent(
        makeRevokeEvent({
          id: 'revoke-1',
          subject: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
          verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      )

      expect(listener.getStats().duplicatesSkipped).toBe(1)
    })
  })

  // ── Score invalidation ─────────────────────────────────────────────

  describe('score invalidation', () => {
    it('should invoke onScoreInvalidation with affected addresses after polling', async () => {
      const invalidationSpy = vi.fn()
      const events = [
        makeAddEvent({ id: 'e1', subject: 'ADDR_A' }),
        makeAddEvent({ id: 'e2', subject: 'ADDR_B' }),
        makeRevokeEvent({ id: 'e3', subject: 'ADDR_A', verifier: 'V_OTHER' }),
      ]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(store, fetcher, {}, invalidationSpy)
      await listener.start()

      expect(invalidationSpy).toHaveBeenCalledTimes(1)
      const addresses = invalidationSpy.mock.calls[0][0] as string[]
      expect(addresses).toContain('ADDR_A')
      expect(addresses).toContain('ADDR_B')
    })

    it('should not invoke callback when no events are processed', async () => {
      const invalidationSpy = vi.fn()
      const fetcher = createMockFetcher([])

      listener = new AttestationEventListener(store, fetcher, {}, invalidationSpy)
      await listener.start()

      expect(invalidationSpy).not.toHaveBeenCalled()
    })

    it('should continue processing even if score invalidation fails', async () => {
      const failingCallback = vi.fn().mockRejectedValue(new Error('cache down'))
      const events = [makeAddEvent({ id: 'e1' })]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(store, fetcher, {}, failingCallback)
      await listener.start()

      // Attestation should still have been created
      expect(store.size).toBe(1)
      expect(listener.getStats().addEvents).toBe(1)
    })
  })

  // ── Polling and cursor ─────────────────────────────────────────────

  describe('polling', () => {
    it('should update cursor after processing events', async () => {
      const events = [
        makeAddEvent({ id: 'e1', pagingToken: 'cursor-100' }),
        makeAddEvent({ id: 'e2', pagingToken: 'cursor-200' }),
      ]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(store, fetcher, { lastCursor: 'cursor-0' })
      await listener.start()

      expect(listener.getStats().lastCursor).toBe('cursor-200')
    })

    it('should use default cursor "now" when none provided', () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      expect(listener.getStats().lastCursor).toBe('now')
    })

    it('should allow manual cursor override', () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      listener.setCursor('manual-cursor-42')
      expect(listener.getStats().lastCursor).toBe('manual-cursor-42')
    })

    it('should poll again after the configured interval', async () => {
      let callCount = 0
      const fetcher: EventFetcher = async () => {
        callCount++
        return []
      }

      listener = new AttestationEventListener(store, fetcher, { pollingInterval: 1_000 })
      await listener.start()
      expect(callCount).toBe(1)

      // Advance timer by 1 second — should trigger second poll
      await vi.advanceTimersByTimeAsync(1_000)
      expect(callCount).toBe(2)

      listener.stop()
    })

    it('should not poll after stop()', async () => {
      let callCount = 0
      const fetcher: EventFetcher = async () => {
        callCount++
        return []
      }

      listener = new AttestationEventListener(store, fetcher, { pollingInterval: 1_000 })
      await listener.start()
      listener.stop()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(callCount).toBe(1) // Only the initial poll
    })
  })

  // ── Stats ──────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return initial stats', () => {
      const fetcher = createMockFetcher([])
      listener = new AttestationEventListener(store, fetcher)

      const stats = listener.getStats()
      expect(stats.isRunning).toBe(false)
      expect(stats.eventsProcessed).toBe(0)
      expect(stats.addEvents).toBe(0)
      expect(stats.revokeEvents).toBe(0)
      expect(stats.duplicatesSkipped).toBe(0)
      expect(stats.errors).toBe(0)
      expect(stats.lastPollAt).toBeNull()
    })

    it('should reflect processed events in stats', async () => {
      const events = [
        makeAddEvent({ id: 'e1', subject: 'S1' }),
        makeAddEvent({ id: 'e2', subject: 'S2' }),
        makeRevokeEvent({ id: 'e3', subject: 'S1', verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      ]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(store, fetcher)
      await listener.start()

      const stats = listener.getStats()
      expect(stats.eventsProcessed).toBe(3)
      expect(stats.addEvents).toBe(2)
      expect(stats.revokeEvents).toBe(1)
      expect(stats.isRunning).toBe(true)
      expect(stats.lastPollAt).not.toBeNull()
    })
  })

  // ── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('should increment error count on fetch failure and continue', async () => {
      let callCount = 0
      const fetcher: EventFetcher = async () => {
        callCount++
        if (callCount === 1) throw new Error('network error')
        return []
      }

      listener = new AttestationEventListener(store, fetcher, { pollingInterval: 500 })
      await listener.start()

      expect(listener.getStats().errors).toBe(1)

      // Should still schedule next poll
      await vi.advanceTimersByTimeAsync(500)
      expect(callCount).toBe(2)
      listener.stop()
    })

    it('should increment error count for invalid events but continue batch', async () => {
      // Create a store that throws on create for a specific subject
      const brokenStore: AttestationStore = {
        create: (params) => {
          if (params.subject === 'BAD') throw new Error('DB error')
          return store.create(params)
        },
        findById: (id) => store.findById(id),
        findBySubject: (s, o) => store.findBySubject(s, o),
        revoke: (id) => store.revoke(id),
      }

      const events = [
        makeAddEvent({ id: 'e1', subject: 'BAD' }),
        makeAddEvent({ id: 'e2', subject: 'GOOD' }),
      ]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(brokenStore, fetcher)
      await listener.start()

      // First event errors, second succeeds
      expect(listener.getStats().errors).toBe(1)
      expect(listener.getStats().addEvents).toBe(1)
    })
  })

  // ── Integration: full add → revoke flow ────────────────────────────

  describe('integration: add then revoke flow', () => {
    it('should handle a complete add → revoke lifecycle', async () => {
      const subject = 'GSUBJECTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const verifier = 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

      const events = [
        makeAddEvent({ id: 'add-1', subject, verifier, weight: 90, claim: 'ID verified' }),
        makeRevokeEvent({ id: 'revoke-1', subject, verifier }),
      ]
      const fetcher = createMockFetcher(events)

      listener = new AttestationEventListener(store, fetcher)
      await listener.start()

      // Active attestations: 0 (revoked)
      const { attestations: active } = store.findBySubject(subject)
      expect(active).toHaveLength(0)

      // Including revoked: 1
      const { attestations: all } = store.findBySubject(subject, { includeRevoked: true })
      expect(all).toHaveLength(1)
      expect(all[0].revokedAt).not.toBeNull()
      expect(all[0].weight).toBe(90)
      expect(all[0].claim).toBe('ID verified')

      const stats = listener.getStats()
      expect(stats.addEvents).toBe(1)
      expect(stats.revokeEvents).toBe(1)
      expect(stats.eventsProcessed).toBe(2)
    })
  })
})
