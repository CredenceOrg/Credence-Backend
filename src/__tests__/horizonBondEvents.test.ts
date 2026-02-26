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
  })
})
