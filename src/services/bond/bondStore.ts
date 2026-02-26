/**
 * In-memory bond store.
 * Acts as the persistence layer for bond records.
 * In production, swap with a PostgreSQL-backed implementation.
 */

import type { BondRecord } from './types.js'

/**
 * In-memory store for bond records, keyed by normalised (lower-case) address.
 */
export class BondStore {
  private records = new Map<string, BondRecord>()

  /**
   * Retrieve a bond record by address.
   *
   * @param address - Ethereum address (case-insensitive).
   * @returns The bond record, or null if not found.
   */
  get(address: string): BondRecord | null {
    return this.records.get(address.toLowerCase()) ?? null
  }

  /**
   * Upsert a bond record. The address is normalised to lower-case.
   *
   * @param record - Bond record to store.
   */
  set(record: BondRecord): void {
    this.records.set(record.address.toLowerCase(), {
      ...record,
      address: record.address.toLowerCase(),
    })
  }

  /**
   * Return all stored bond records.
   *
   * @returns Array of all bond records.
   */
  getAll(): BondRecord[] {
    return Array.from(this.records.values())
  }

  /**
   * Remove a bond record by address.
   *
   * @param address - Ethereum address (case-insensitive).
   * @returns True if a record was removed.
   */
  delete(address: string): boolean {
    return this.records.delete(address.toLowerCase())
  }
}
