import { describe, it, expect, vi } from 'vitest'
import {
  IdentityStateSync,
  createIdentityStateSync,
  type ContractReader,
  type IdentityState,
  type IdentityStateStore,
} from './index.js'

function makeState(overrides: Partial<IdentityState> & { address: string }): IdentityState {
  return {
    address: overrides.address,
    bondedAmount: overrides.bondedAmount ?? '0',
    bondStart: overrides.bondStart ?? null,
    bondDuration: overrides.bondDuration ?? null,
    active: overrides.active ?? false,
  }
}

describe('IdentityStateSync', () => {
  describe('reconcileByAddress', () => {
    it('no drift: chain and DB match, does not update', async () => {
      const state = makeState({
        address: '0xabc',
        bondedAmount: '100',
        bondStart: 1000,
        bondDuration: 3600,
        active: true,
      })
      const contract: ContractReader = {
        getIdentityState: async () => state,
      }
      const store: IdentityStateStore = {
        get: async () => state,
        set: async () => {},
        getAllAddresses: async () => ['0xabc'],
      }
      const setSpy = vi.spyOn(store, 'set')
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.reconcileByAddress('0xabc')
      expect(result).toEqual({ address: '0xabc', updated: false, reason: 'no_drift' })
      expect(setSpy).not.toHaveBeenCalled()
    })

    it('single drift: DB out of date, updates store to match chain', async () => {
      const chainState = makeState({
        address: '0xdef',
        bondedAmount: '200',
        bondStart: 2000,
        bondDuration: 7200,
        active: true,
      })
      const dbState = makeState({
        address: '0xdef',
        bondedAmount: '100',
        bondStart: 1000,
        active: false,
      })
      const contract: ContractReader = {
        getIdentityState: async () => chainState,
      }
      let saved: IdentityState | null = null
      const store: IdentityStateStore = {
        get: async () => dbState,
        set: async (s) => {
          saved = s
        },
        getAllAddresses: async () => ['0xdef'],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.reconcileByAddress('0xdef')
      expect(result).toEqual({ address: '0xdef', updated: true })
      expect(saved).toEqual(chainState)
    })

    it('chain missing: identity not on chain, does not update', async () => {
      const contract: ContractReader = {
        getIdentityState: async () => null,
      }
      const store: IdentityStateStore = {
        get: async () => makeState({ address: '0xold', bondedAmount: '50' }),
        set: async () => {},
        getAllAddresses: async () => ['0xold'],
      }
      const setSpy = vi.spyOn(store, 'set')
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.reconcileByAddress('0xold')
      expect(result).toEqual({ address: '0xold', updated: false, reason: 'chain_missing' })
      expect(setSpy).not.toHaveBeenCalled()
    })

    it('DB empty: chain has state, writes to store', async () => {
      const chainState = makeState({
        address: '0xnew',
        bondedAmount: '300',
        bondStart: 3000,
        active: true,
      })
      const contract: ContractReader = {
        getIdentityState: async () => chainState,
      }
      let saved: IdentityState | null = null
      const store: IdentityStateStore = {
        get: async () => null,
        set: async (s) => {
          saved = s
        },
        getAllAddresses: async () => [],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.reconcileByAddress('0xnew')
      expect(result).toEqual({ address: '0xnew', updated: true })
      expect(saved).toEqual(chainState)
    })

    it('contract throws: returns error reason, does not update', async () => {
      const contract: ContractReader = {
        getIdentityState: async () => {
          throw new Error('RPC error')
        },
      }
      const store: IdentityStateStore = {
        get: async () => makeState({ address: '0xerr' }),
        set: async () => {},
        getAllAddresses: async () => [],
      }
      const setSpy = vi.spyOn(store, 'set')
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.reconcileByAddress('0xerr')
      expect(result).toEqual({ address: '0xerr', updated: false, reason: 'error' })
      expect(setSpy).not.toHaveBeenCalled()
    })
  })

  describe('fullResync', () => {
    it('no drift: all addresses in sync, no updates', async () => {
      const stateA = makeState({ address: '0xa', bondedAmount: '10' })
      const stateB = makeState({ address: '0xb', bondedAmount: '20' })
      const contract: ContractReader = {
        getIdentityState: async (addr) =>
          addr === '0xa' ? stateA : addr === '0xb' ? stateB : null,
        getAllIdentityAddresses: async () => ['0xa', '0xb'],
      }
      const store: IdentityStateStore = {
        get: async (addr) => (addr === '0xa' ? stateA : addr === '0xb' ? stateB : null),
        set: async () => {},
        getAllAddresses: async () => ['0xa', '0xb'],
      }
      const setSpy = vi.spyOn(store, 'set')
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.fullResync()
      expect(result.total).toBe(2)
      expect(result.updated).toBe(0)
      expect(result.results).toHaveLength(2)
      expect(result.results.every((r) => r.updated === false && r.reason === 'no_drift')).toBe(true)
      expect(setSpy).not.toHaveBeenCalled()
    })

    it('single drift: one identity out of sync, corrects it', async () => {
      const stateA = makeState({ address: '0xa', bondedAmount: '10' })
      const stateBChain = makeState({ address: '0xb', bondedAmount: '200' })
      const stateBDb = makeState({ address: '0xb', bondedAmount: '100' })
      const contract: ContractReader = {
        getIdentityState: async (addr) =>
          addr === '0xa' ? stateA : addr === '0xb' ? stateBChain : null,
        getAllIdentityAddresses: async () => ['0xa', '0xb'],
      }
      const updates: IdentityState[] = []
      const store: IdentityStateStore = {
        get: async (addr) =>
          addr === '0xa' ? stateA : addr === '0xb' ? stateBDb : null,
        set: async (s) => {
          updates.push(s)
        },
        getAllAddresses: async () => ['0xa', '0xb'],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.fullResync()
      expect(result.total).toBe(2)
      expect(result.updated).toBe(1)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual(stateBChain)
      const updatedResult = result.results.find((r) => r.updated)
      expect(updatedResult).toEqual({ address: '0xb', updated: true })
    })

    it('full resync: multiple drifts, corrects all', async () => {
      const chainA = makeState({ address: '0xa', bondedAmount: '100' })
      const chainB = makeState({ address: '0xb', bondedAmount: '200' })
      const dbA = makeState({ address: '0xa', bondedAmount: '50' })
      const dbB = makeState({ address: '0xb', bondedAmount: '150' })
      const contract: ContractReader = {
        getIdentityState: async (addr) => (addr === '0xa' ? chainA : addr === '0xb' ? chainB : null),
        getAllIdentityAddresses: async () => ['0xa', '0xb'],
      }
      const updates: IdentityState[] = []
      const store: IdentityStateStore = {
        get: async (addr) => (addr === '0xa' ? dbA : addr === '0xb' ? dbB : null),
        set: async (s) => {
          updates.push(s)
        },
        getAllAddresses: async () => ['0xa', '0xb'],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.fullResync()
      expect(result.total).toBe(2)
      expect(result.updated).toBe(2)
      expect(updates).toHaveLength(2)
      expect(updates.map((u) => u.address).sort()).toEqual(['0xa', '0xb'])
      expect(updates.find((u) => u.address === '0xa')).toEqual(chainA)
      expect(updates.find((u) => u.address === '0xb')).toEqual(chainB)
    })

    it('full resync: merges store and contract addresses when contract has getAllIdentityAddresses', async () => {
      const stateNew = makeState({ address: '0xnew', bondedAmount: '99' })
      const contract: ContractReader = {
        getIdentityState: async (addr) => (addr === '0xnew' ? stateNew : null),
        getAllIdentityAddresses: async () => ['0xnew'],
      }
      const store: IdentityStateStore = {
        get: async () => null,
        set: async () => {},
        getAllAddresses: async () => ['0xold'],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.fullResync()
      expect(result.total).toBe(2)
      expect(result.results.map((r) => r.address).sort()).toEqual(['0xnew', '0xold'])
    })

    it('full resync: uses only store addresses when contract has no getAllIdentityAddresses', async () => {
      const stateA = makeState({ address: '0xa', bondedAmount: '10' })
      const contract: ContractReader = {
        getIdentityState: async () => stateA,
        // no getAllIdentityAddresses
      }
      const store: IdentityStateStore = {
        get: async () => stateA,
        set: async () => {},
        getAllAddresses: async () => ['0xa'],
      }
      const sync = new IdentityStateSync(contract, store)
      const result = await sync.fullResync()
      expect(result.total).toBe(1)
      expect(result.results).toHaveLength(1)
      expect(result.results[0].address).toBe('0xa')
    })
  })
})

describe('createIdentityStateSync', () => {
  it('returns IdentityStateSync instance', () => {
    const contract: ContractReader = { getIdentityState: async () => null }
    const store: IdentityStateStore = {
      get: async () => null,
      set: async () => {},
      getAllAddresses: async () => [],
    }
    const sync = createIdentityStateSync(contract, store)
    expect(sync).toBeInstanceOf(IdentityStateSync)
    expect(sync.reconcileByAddress).toBeDefined()
    expect(sync.fullResync).toBeDefined()
  })
})
