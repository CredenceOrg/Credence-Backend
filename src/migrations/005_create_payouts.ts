import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('payouts', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    recipient: {
      type: 'text',
      notNull: true,
    },
    amount: {
      type: 'numeric(36, 18)',
      notNull: true,
    },
    currency: {
      type: 'text',
      notNull: true,
      default: "'USD'",
    },
    status: {
      type: 'text',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending', 'processing', 'completed', 'failed')",
    },
    metadata: {
      type: 'jsonb',
      default: "'{}'::jsonb",
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

  pgm.addConstraint('payouts', 'payouts_amount_positive', {
    check: 'amount > 0',
  })

  pgm.createIndex('payouts', 'recipient', { name: 'idx_payouts_recipient' })
  pgm.createIndex('payouts', 'status', { name: 'idx_payouts_status' })
  pgm.createIndex('payouts', [{ name: 'created_at', sort: 'DESC' }], {
    name: 'idx_payouts_created_at',
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('payouts')
}
