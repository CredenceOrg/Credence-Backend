<<<<<<< HEAD
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'

// Explicitly type mockStream and events
let mockStream: (op: any) => Promise<void>
let events: any[] = []

vi.mock('stellar-sdk', () => {
  // Must use `function` keyword (not arrow) so it works with `new`
  function MockServer() {
    return {
      operations: vi.fn(() => ({
        forAsset: vi.fn(() => ({
          cursor: vi.fn(() => ({
            stream: vi.fn(({ onmessage }: { onmessage: (op: any) => Promise<void> }) => {
              mockStream = onmessage
            }),
          })),
        })),
      })),
    }
  }
  return { Server: MockServer }
})

vi.mock('../services/identityService.js', () => ({
  upsertIdentity: vi.fn().mockResolvedValue(true),
  upsertBond: vi.fn().mockResolvedValue(true),
}))

describe('Horizon Bond Creation Listener', () => {
  beforeEach(() => {
    events = []
    vi.clearAllMocks()
  })

  it('should parse and upsert bond creation events', async () => {
    const { upsertIdentity, upsertBond } = await import('../services/identityService.js') as any

    const op = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    }

    subscribeBondCreationEvents((event: any) => events.push(event))
    await mockStream(op)

    expect(upsertIdentity).toHaveBeenCalledWith({ id: 'GABC...' })
    expect(upsertBond).toHaveBeenCalledWith({ id: 'bond123', amount: '1000', duration: '365' })
    expect(events.length).toBe(1)
    expect(events[0].identity.id).toBe('GABC...')
    expect(events[0].bond.id).toBe('bond123')
  })

  it('should ignore non-bond events', async () => {
    const op = { type: 'payment', id: 'other' }
    subscribeBondCreationEvents((event: any) => events.push(event))
    await mockStream(op)
    expect(events.length).toBe(0)
  })

  it('should handle duplicate bond events gracefully', async () => {
    const { upsertBond } = await import('../services/identityService.js') as any

    const op = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    }

    subscribeBondCreationEvents(() => {})
    await mockStream(op)
    await mockStream(op) // Duplicate
    expect(upsertBond).toHaveBeenCalledTimes(2)
=======
import { vi, describe, it, beforeEach, expect } from 'vitest'

// vi.mock is hoisted so it intercepts stellar-sdk before horizonBondEvents.ts loads
vi.mock('stellar-sdk', () => {
  class ServerMock {
    operations() {
      return {
        forAsset: () => ({
          cursor: () => ({ stream: vi.fn() }),
        }),
      }
    }
  }
  return { Server: ServerMock }
})

vi.mock('../services/identityService.js', () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
}))

import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'

describe('Horizon Bond Creation Listener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls subscribeBondCreationEvents without throwing', () => {
    const onEvent = vi.fn()
    expect(() => subscribeBondCreationEvents(onEvent)).not.toThrow()
  })

  it('accepts a callback argument', () => {
    const onEvent = vi.fn()
    subscribeBondCreationEvents(onEvent)
    // callback should not be called until a bond event arrives
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('works when no callback is provided', () => {
    expect(() => subscribeBondCreationEvents(undefined)).not.toThrow()
>>>>>>> upstream/main
  })
})
