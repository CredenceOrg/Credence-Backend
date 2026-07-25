import { beforeEach, describe, expect, it, vi } from 'vitest'

const streamState = vi.hoisted(() => ({
  onmessage: undefined as undefined | ((op: any) => Promise<void>),
}))

vi.mock('@stellar/stellar-sdk', () => {
  class ServerMock {
    operations() {
      return {
        forAsset: () => ({
          cursor: () => ({
            stream: ({ onmessage }: { onmessage: (op: any) => Promise<void> }) => {
              streamState.onmessage = onmessage
            },
          }),
        }),
      }
    }
  }

  return {
    Horizon: { Server: ServerMock },
    StrKey: {
      isValidEd25519PublicKey: (account: string) => typeof account === 'string' && account.startsWith('G'),
      isValidMuxedAccount: () => false,
    },
  }
})

vi.mock('../services/identityService', () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
}))

import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'
import { upsertBond, upsertIdentity } from '../services/identityService.js'

describe('Horizon Bond Creation Listener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamState.onmessage = undefined
  })

  it('subscribes without throwing', () => {
    expect(() => subscribeBondCreationEvents({ captureFailure: vi.fn() })).not.toThrow()
    expect(streamState.onmessage).toBeTypeOf('function')
  })

  it('accepts an undefined callback', () => {
    expect(() => subscribeBondCreationEvents({ captureFailure: vi.fn() }, undefined)).not.toThrow()
    expect(streamState.onmessage).toBeTypeOf('function')
  })

  it('parses and upserts create_bond events', async () => {
    const onEvent = vi.fn()
    subscribeBondCreationEvents({ captureFailure: vi.fn() }, onEvent)

    await streamState.onmessage?.({
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    })

    expect(upsertIdentity).toHaveBeenCalledWith({ id: 'GABC...' })
    expect(upsertBond).toHaveBeenCalledWith({ id: 'bond123', address: 'GABC...', amount: '1000', duration: '365' })
    expect(onEvent).toHaveBeenCalledWith({
      identity: { id: 'GABC...' },
      bond: { id: 'bond123', address: 'GABC...', amount: '1000', duration: '365' },
    })
  })

  it('ignores non-bond events', async () => {
    const onEvent = vi.fn()
    subscribeBondCreationEvents({ captureFailure: vi.fn() }, onEvent)

    await streamState.onmessage?.({
      type: 'payment',
      id: 'other',
      paging_token: 'token2',
    })

    expect(upsertIdentity).not.toHaveBeenCalled()
    expect(upsertBond).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('handles duplicate create_bond events consistently', async () => {
    subscribeBondCreationEvents({ captureFailure: vi.fn() }, vi.fn())

    const event = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    }

    await streamState.onmessage?.(event)
    await streamState.onmessage?.(event)

    expect(upsertIdentity).toHaveBeenCalledTimes(2)
    expect(upsertBond).toHaveBeenCalledTimes(2)
  })
})
