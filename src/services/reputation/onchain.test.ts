import { describe, expect, it, vi } from 'vitest'
import {
  OnchainError,
  OnchainReputationService,
  type SorobanRpcClient,
} from './onchain.js'

const VALID_ADDRESS = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'

function createService(rpcClient: SorobanRpcClient, cacheTtlMs = 15000): OnchainReputationService {
  return new OnchainReputationService({
    rpcUrl: 'https://rpc.example.test',
    contractId: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    rpcClient,
    timeoutMs: 20,
    cacheTtlMs,
  })
}

describe('OnchainReputationService', () => {
  it('fetches and decodes identity state', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi.fn().mockResolvedValue({
        bonded_amount: '1000',
        bond_start: 1700000000,
        bond_duration: 86400,
        active: true,
        attestation_count: 3,
        slashed: false,
      }),
    }
    const service = createService(rpcClient)

    const state = await service.getIdentityState(VALID_ADDRESS)
    expect(state).toEqual({
      address: VALID_ADDRESS,
      bondedAmount: '1000',
      bondStart: 1700000000,
      bondDuration: 86400,
      active: true,
      attestationCount: 3,
      slashed: false,
    })
  })

  it('returns null for missing on-chain state', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi.fn().mockResolvedValue(null),
    }
    const service = createService(rpcClient)

    const state = await service.getIdentityState(VALID_ADDRESS)
    expect(state).toBeNull()
  })

  it('rejects invalid address', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi.fn(),
    }
    const service = createService(rpcClient)

    await expect(service.getIdentityState('INVALID')).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    })
    expect(rpcClient.readIdentityState).not.toHaveBeenCalled()
  })

  it('maps timeout errors', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(null), 100)
        }),
    }
    const service = createService(rpcClient)

    await expect(service.getIdentityState(VALID_ADDRESS)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  it('maps network errors', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi.fn().mockRejectedValue(new Error('fetch failed')),
    }
    const service = createService(rpcClient)

    await expect(service.getIdentityState(VALID_ADDRESS)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    })
  })

  it('maps decode errors', async () => {
    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi.fn().mockResolvedValue({
        bonded_amount: '1000',
        active: 'yes',
      }),
    }
    const service = createService(rpcClient)

    await expect(service.getIdentityState(VALID_ADDRESS)).rejects.toBeInstanceOf(OnchainError)
    await expect(service.getIdentityState(VALID_ADDRESS)).rejects.toMatchObject({
      code: 'DECODE_ERROR',
    })
  })

  it('uses cache within TTL and refetches after expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-25T00:00:00.000Z'))

    const rpcClient: SorobanRpcClient = {
      readIdentityState: vi
        .fn()
        .mockResolvedValueOnce({
          bonded_amount: '1000',
          active: true,
        })
        .mockResolvedValueOnce({
          bonded_amount: '2000',
          active: false,
        }),
    }

    const service = createService(rpcClient, 1000)
    const first = await service.getIdentityState(VALID_ADDRESS)
    const second = await service.getIdentityState(VALID_ADDRESS)

    expect(first?.bondedAmount).toBe('1000')
    expect(second?.bondedAmount).toBe('1000')
    expect(rpcClient.readIdentityState).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-02-25T00:00:01.100Z'))
    const third = await service.getIdentityState(VALID_ADDRESS)

    expect(third?.bondedAmount).toBe('2000')
    expect(rpcClient.readIdentityState).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
