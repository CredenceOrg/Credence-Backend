/**
 * Types for the bond status service.
 */

/**
 * A bond record stored in the database.
 */
export interface BondRecord {
  /** Identity (wallet) address. */
  address: string
  /** Bonded amount as string (e.g. wei or token amount). */
  bondedAmount: string
  /** ISO 8601 timestamp when the bond was first posted, or null if unbonded. */
  bondStart: string | null
  /** Bond duration in seconds, or null if unbonded. */
  bondDuration: number | null
  /** Whether the bond is currently active. */
  active: boolean
  /** Total amount slashed from this bond (string for precision). */
  slashedAmount: string
}
