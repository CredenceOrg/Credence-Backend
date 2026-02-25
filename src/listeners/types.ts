/**
 * Canonical identity/bond state used for sync between on-chain and DB.
 * Matches the shape used by the bond API and contract.
 */
export interface IdentityState {
  /** Identity (e.g. wallet) address. */
  address: string
  /** Bonded amount as string (e.g. wei or token amount). */
  bondedAmount: string
  /** Bond start timestamp (seconds) or null if not bonded. */
  bondStart: number | null
  /** Bond duration in seconds or null. */
  bondDuration: number | null
  /** Whether the bond is currently active. */
  active: boolean
}

/**
 * Fetches current identity/bond state from the contract (on-chain).
 * Implement with your chain client (e.g. Horizon, ethers).
 */
export interface ContractReader {
  /** Get current state for one identity. Returns null if not found or not bonded. */
  getIdentityState(address: string): Promise<IdentityState | null>
  /** Get all identity addresses that have on-chain state (for full resync). */
  getAllIdentityAddresses?(): Promise<string[]>
}

/**
 * Persisted identity/bond state (e.g. database).
 * Used to diff with on-chain and correct drift.
 */
export interface IdentityStateStore {
  /** Get stored state for an address, or null if not found. */
  get(address: string): Promise<IdentityState | null>
  /** Persist identity state (upsert by address). */
  set(state: IdentityState): Promise<void>
  /** List all addresses we have stored (for full resync). */
  getAllAddresses(): Promise<string[]>
}
