import type { ContractReader, IdentityState, IdentityStateStore } from './types.js'

/** Result of reconciling one identity. */
export interface ReconcileResult {
  address: string
  /** Whether DB was updated to match chain. */
  updated: boolean
  /** Reason when not updated: 'no_drift' | 'chain_missing' | 'error' */
  reason?: 'no_drift' | 'chain_missing' | 'error'
}

/** Result of a full resync run. */
export interface FullResyncResult {
  /** Total identities considered (from store + chain). */
  total: number
  /** Number of identities that were updated (drift corrected). */
  updated: number
  /** Per-address results. */
  results: ReconcileResult[]
}

/**
 * Returns true if two identity states are equal (no drift).
 */
function statesEqual(a: IdentityState | null, b: IdentityState | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return (
    a.address === b.address &&
    a.bondedAmount === b.bondedAmount &&
    a.bondStart === b.bondStart &&
    a.bondDuration === b.bondDuration &&
    a.active === b.active
  )
}

/**
 * Identity state sync service: keeps DB in sync with on-chain state.
 * Supports reconciliation by address and full resync for recovery.
 */
export class IdentityStateSync {
  constructor(
    private readonly contract: ContractReader,
    private readonly store: IdentityStateStore
  ) {}

  /**
   * Reconcile one identity by address: fetch chain state, diff with DB, correct drift.
   * @param address - Identity address to reconcile
   * @returns Result indicating whether the store was updated
   */
  async reconcileByAddress(address: string): Promise<ReconcileResult> {
    try {
      const chainState = await this.contract.getIdentityState(address)
      if (chainState === null) {
        return { address, updated: false, reason: 'chain_missing' }
      }
      const dbState = await this.store.get(address)
      if (statesEqual(chainState, dbState)) {
        return { address, updated: false, reason: 'no_drift' }
      }
      await this.store.set(chainState)
      return { address, updated: true }
    } catch {
      return { address, updated: false, reason: 'error' }
    }
  }

  /**
   * Full resync: reconcile all known addresses (store + contract) to correct any drift.
   * Use for recovery after missed events or initial bootstrap.
   */
  async fullResync(): Promise<FullResyncResult> {
    const storeAddresses = await this.store.getAllAddresses()
    const chainAddresses = this.contract.getAllIdentityAddresses
      ? await this.contract.getAllIdentityAddresses()
      : []
    const allAddresses = new Set<string>([...storeAddresses, ...chainAddresses])
    const results: ReconcileResult[] = []
    let updated = 0
    for (const address of allAddresses) {
      const result = await this.reconcileByAddress(address)
      results.push(result)
      if (result.updated) updated += 1
    }
    return {
      total: allAddresses.size,
      updated,
      results,
    }
  }
}

/**
 * Create a sync service with the given contract reader and state store.
 *
 * @param contract - Reads current state from chain (Horizon/contract)
 * @param store - Persists identity state (e.g. DB)
 * @returns IdentityStateSync instance
 */
export function createIdentityStateSync(
  contract: ContractReader,
  store: IdentityStateStore
): IdentityStateSync {
  return new IdentityStateSync(contract, store)
}
