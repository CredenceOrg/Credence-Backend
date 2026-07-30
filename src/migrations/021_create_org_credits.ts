import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Credits balance table – one row per org, optimistic locking via version
  pgm.createTable('org_credits', {
    org_id: { type: 'uuid', primaryKey: true },
    credits_remaining: { type: 'bigint', notNull: true, default: '0' },
    version: { type: 'integer', notNull: true, default: 1 },
    last_top_up_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  })

  // Audit trail for all credit movements
  pgm.createTable('credit_transactions', {
    id: { type: 'bigserial', primaryKey: true },
    org_id: { type: 'uuid', notNull: true },
    transaction_type: { type: 'varchar(20)', notNull: true },
    amount: { type: 'bigint', notNull: true },
    credits_remaining_before: { type: 'bigint', notNull: true },
    credits_remaining_after: { type: 'bigint', notNull: true },
    endpoint: { type: 'text' },
    cost_weight: { type: 'integer' },
    request_id: { type: 'text' },
    failure_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  })

  pgm.createIndex('credit_transactions', 'org_id')
  pgm.createIndex('credit_transactions', 'created_at')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('credit_transactions')
  pgm.dropTable('org_credits')
}
