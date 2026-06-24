import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined

export async function up(pgm: MigrationBuilder): Promise<void> {
  /**
   * Drop the composite unique constraint on (bond_id, transaction_hash)
   * and replace it with a unique constraint on transaction_hash alone.
   * This ensures idempotency across all settlements for the same on-chain
   * transaction, preventing duplicates even if Horizon events are replayed
   * or requests are retried.
   */
  pgm.dropConstraint('settlements', 'settlements_bond_tx_unique')

  // Add unique constraint on transaction_hash alone
  pgm.addConstraint('settlements', 'settlements_transaction_hash_unique', {
    unique: ['transaction_hash'],
  })

  /**
   * Keep the composite index (bond_id, transaction_hash) for efficient
   * queries filtering settlements by bond_id.
   */
  pgm.createIndex('settlements', ['bond_id', 'transaction_hash'], {
    name: 'idx_settlements_bond_tx',
    ifNotExists: true,
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop the transaction_hash unique constraint
  pgm.dropConstraint('settlements', 'settlements_transaction_hash_unique')

  // Drop the composite index
  pgm.dropIndex('settlements', ['bond_id', 'transaction_hash'], {
    name: 'idx_settlements_bond_tx',
    ifNotExists: true,
  })

  // Restore the original composite unique constraint
  pgm.addConstraint('settlements', 'settlements_bond_tx_unique', {
    unique: ['bond_id', 'transaction_hash'],
  })
}
