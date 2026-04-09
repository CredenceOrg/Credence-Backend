import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', primaryKey: true },
    request_hash: { type: 'text', notNull: true },
    response_code: { type: 'integer', notNull: true },
    response_body: { type: 'jsonb', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Index on expires_at for cleanup jobs
  pgm.createIndex('idempotency_keys', 'expires_at')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('idempotency_keys')
}
