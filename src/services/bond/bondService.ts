/**
 * Bond service — business logic for bond status queries.
 */

import type { BondRecord } from './types.js'
import type { BondStore } from './bondStore.js'

/** Ethereum address regex: 0x followed by exactly 40 hex characters. */
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

/**
 * Service for querying bond status from the store.
 */
export class BondService {
  /**
   * @param store - The bond persistence layer.
   */
  constructor(private readonly store: BondStore) {}

  /**
   * Validate an Ethereum address format.
   *
   * @param address - The address string to validate.
   * @returns True if the address is a valid Ethereum address.
   */
  isValidAddress(address: string): boolean {
    return ETH_ADDRESS_REGEX.test(address)
  }

  /**
   * Retrieve bond status for an address.
   *
   * @param address - Ethereum address (case-insensitive).
   * @returns The bond record, or null if no bond exists for this address.
   */
  getBondStatus(address: string): BondRecord | null {
    return this.store.get(address)
  }
}
