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
  })
})
