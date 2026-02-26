import { describe, it, expect, vi } from 'vitest'
import { detectEventType, emitWebhookForStateChange } from './webhookIntegration.js'
import type { IdentityState } from './types.js'
import type { WebhookService } from '../services/webhooks/index.js'

describe('detectEventType', () => {
  const baseState: IdentityState = {
    address: '0xabc',
    bondedAmount: '1000',
    bondStart: 1234567890,
    bondDuration: 86400,
    active: true,
  }

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
      bondedAmount: '1000000000000000000000', // 1000 ETH in wei
      active: true,
    }
    const newState: IdentityState = {
      ...baseState,
      bondedAmount: '500000000000000000000', // 500 ETH in wei
      active: true,
    }
    const event = detectEventType(oldState, newState)
    expect(event).toBe('bond.slashed')
  })
})

describe('emitWebhookForStateChange', () => {
  const baseState: IdentityState = {
    address: '0xabc',
    bondedAmount: '1000',
    bondStart: 1234567890,
    bondDuration: 86400,
    active: true,
  }

  it('emits webhook when event is detected', async () => {
    const mockWebhookService = {
      emit: vi.fn().mockResolvedValue([]),
    } as unknown as WebhookService

    const oldState = null
    const newState = baseState

    await emitWebhookForStateChange(mockWebhookService, oldState, newState)

    expect(mockWebhookService.emit).toHaveBeenCalledWith('bond.created', {
      address: '0xabc',
      bondedAmount: '1000',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })
  })

  it('does not emit webhook when no event detected', async () => {
    const mockWebhookService = {
      emit: vi.fn().mockResolvedValue([]),
    } as unknown as WebhookService

    const oldState = baseState
    const newState = baseState

    await emitWebhookForStateChange(mockWebhookService, oldState, newState)

    expect(mockWebhookService.emit).not.toHaveBeenCalled()
  })

  it('emits bond.slashed event with correct data', async () => {
    const mockWebhookService = {
      emit: vi.fn().mockResolvedValue([]),
    } as unknown as WebhookService

    const oldState: IdentityState = { ...baseState, bondedAmount: '1000' }
    const newState: IdentityState = { ...baseState, bondedAmount: '500' }

    await emitWebhookForStateChange(mockWebhookService, oldState, newState)

    expect(mockWebhookService.emit).toHaveBeenCalledWith('bond.slashed', {
      address: '0xabc',
      bondedAmount: '500',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: true,
    })
  })

  it('emits bond.withdrawn event with correct data', async () => {
    const mockWebhookService = {
      emit: vi.fn().mockResolvedValue([]),
    } as unknown as WebhookService

    const oldState: IdentityState = { ...baseState, active: true }
    const newState: IdentityState = { ...baseState, active: false, bondedAmount: '0' }

    await emitWebhookForStateChange(mockWebhookService, oldState, newState)

    expect(mockWebhookService.emit).toHaveBeenCalledWith('bond.withdrawn', {
      address: '0xabc',
      bondedAmount: '0',
      bondStart: 1234567890,
      bondDuration: 86400,
      active: false,
    })
  })
})
