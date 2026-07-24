import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('settlements', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    bond_id: {
      type: 'uuid',
      notNull: true,
      references: 'bonds(id)',
      onDelete: 'CASCADE',
    },
    amount: {
      type: 'numeric(36, 18)',
      notNull: true,
    },
    transaction_hash: {
      type: 'varchar(128)',
      notNull: true,
    },
    settled_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    status: {
      type: 'text',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending', 'settled', 'failed')",
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  pgm.addConstraint('settlements', 'settlements_amount_nonnegative', {
    check: 'amount >= 0',
  })

  pgm.addConstraint('settlements', 'settlements_bond_tx_unique', {
    unique: ['bond_id', 'transaction_hash'],
  })

  pgm.createIndex('settlements', 'bond_id', {
    name: 'idx_settlements_bond_id',
    ifNotExists: true,
  })

  pgm.createIndex('settlements', 'status', {
    name: 'idx_settlements_status',
    ifNotExists: true,
  })

  pgm.createIndex('settlements', [{ name: 'settled_at', sort: 'DESC' }], {
    name: 'idx_settlements_settled_at',
    ifNotExists: true,
  })

  pgm.createIndex('settlements', 'transaction_hash', {
    name: 'idx_settlements_transaction_hash',
    ifNotExists: true,
  })

  pgm.sql(`
    CREATE TRIGGER settlements_updated_at
      BEFORE UPDATE ON settlements
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS settlements_updated_at ON settlements;')
  pgm.dropTable('settlements')
}
