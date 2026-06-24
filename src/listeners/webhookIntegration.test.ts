import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectEventType } from './webhookEventDetection.js'
import { emitWebhookForStateChange } from './webhookIntegrationOutbox.js'
import type { IdentityState } from './types.js'

vi.mock('../db/outbox/emitter.js', () => ({
  outboxEmitter: {
    emit: vi.fn().mockResolvedValue(1n),
  },
}))

import { outboxEmitter } from '../db/outbox/emitter.js'

const baseState: IdentityState = {
  address: '0xabc',
  bondedAmount: '1000',
  bondStart: 1234567890,
  bondDuration: 86400,
  active: true,
}

describe('detectEventType', () => {
  it('detects bond.created when transitioning from null to active', () => {
    const event = detectEventType(null, baseState)
    expect(event).toBe('bond.created')
  })

  it('detects bond.created when transitioning from inactive to active', () => {
    const oldState: IdentityState = { ...baseState, active: false, bondedAmount: '0' }
    const newState: IdentityState = { ...baseState, active: true }
    const event = detectEventType(oldState, newState)
    expect(event).toBe('bond.created')
  })

  it('detects bond.withdrawn when transitioning from active to inactive with zero amount', () => {
    const oldState: IdentityState = { ...baseState, active: true }
    const newState: IdentityState = { ...baseState, active: false, bondedAmount: '0' }
    const event = detectEventType(oldState, newState)
    expect(event).toBe('bond.withdrawn')
  })

  it('detects bond.slashed when amount decreases while active', () => {
    const oldState: IdentityState = { ...baseState, bondedAmount: '1000', active: true }
    const newState: IdentityState = { ...baseState, bondedAmount: '500', active: true }
    const event = detectEventType(oldState, newState)
    expect(event).toBe('bond.slashed')
  })

  it('returns null when amount increases (not a slash)', () => {
    const oldState: IdentityState = { ...baseState, bondedAmount: '1000', active: true }
    const newState: IdentityState = { ...baseState, bondedAmount: '2000', active: true }
    const event = detectEventType(oldState, newState)
    expect(event).toBeNull()
  })

  it('returns null when no significant change', () => {
    const oldState: IdentityState = { ...baseState }
    const newState: IdentityState = { ...baseState }
    const event = detectEventType(oldState, newState)
    expect(event).toBeNull()
  })

  it('returns null when both states are inactive', () => {
    const oldState: IdentityState = { ...baseState, active: false }
    const newState: IdentityState = { ...baseState, active: false }
    const event = detectEventType(oldState, newState)
    expect(event).toBeNull()
  })

  it('handles large bond amounts correctly', () => {
    const oldState: IdentityState = {
      ...baseState,
      bondedAmount: '1000000000000000000000',
      active: true,
    }
    const newState: IdentityState = {
      ...baseState,
      bondedAmount: '500000000000000000000',
      active: true,
    }
    const event = detectEventType(oldState, newState)
    expect(event).toBe('bond.slashed')
  })
})

describe('emitWebhookForStateChange (outbox)', () => {
  const mockDb = {} as Parameters<typeof emitWebhookForStateChange>[0]

  beforeEach(() => {
    vi.mocked(outboxEmitter.emit).mockClear()
  })

  it('emits to outbox when event is detected', async () => {
    await emitWebhookForStateChange(mockDb, null, baseState)

    expect(outboxEmitter.emit).toHaveBeenCalledWith(mockDb, {
      aggregateType: 'identity',
      aggregateId: '0xabc',
      eventType: 'bond.created',
      payload: {
        address: '0xabc',
        bondedAmount: '1000',
        bondStart: 1234567890,
        bondDuration: 86400,
        active: true,
      },
    })
  })

  it('does not emit to outbox when no event detected', async () => {
    await emitWebhookForStateChange(mockDb, baseState, baseState)

    expect(outboxEmitter.emit).not.toHaveBeenCalled()
  })

  it('emits bond.slashed event with correct payload', async () => {
    const oldState: IdentityState = { ...baseState, bondedAmount: '1000' }
    const newState: IdentityState = { ...baseState, bondedAmount: '500' }

    await emitWebhookForStateChange(mockDb, oldState, newState)

    expect(outboxEmitter.emit).toHaveBeenCalledWith(mockDb, {
      aggregateType: 'identity',
      aggregateId: '0xabc',
      eventType: 'bond.slashed',
      payload: {
        address: '0xabc',
        bondedAmount: '500',
        bondStart: 1234567890,
        bondDuration: 86400,
        active: true,
      },
    })
  })

  it('emits bond.withdrawn event with correct payload', async () => {
    const oldState: IdentityState = { ...baseState, active: true }
    const newState: IdentityState = { ...baseState, active: false, bondedAmount: '0' }

    await emitWebhookForStateChange(mockDb, oldState, newState)

    expect(outboxEmitter.emit).toHaveBeenCalledWith(mockDb, {
      aggregateType: 'identity',
      aggregateId: '0xabc',
      eventType: 'bond.withdrawn',
      payload: {
        address: '0xabc',
        bondedAmount: '0',
        bondStart: 1234567890,
        bondDuration: 86400,
        active: false,
      },
    })
  })
})
