import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('webhook_dlq', {
    id: { type: 'varchar(255)', primaryKey: true },
    webhook_id: { type: 'varchar(255)', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    failed_at: { type: 'timestamptz', notNull: true },
    attempts: { type: 'integer', notNull: true },
    last_status_code: { type: 'integer' },
    last_error: { type: 'text' },
    response_body_snippet: { type: 'text' },
    replayed_at: { type: 'timestamptz' },
  })

  // Index for listing ordered by failed_at
  pgm.createIndex('webhook_dlq', 'failed_at')
  // Index for querying by webhook_id
  pgm.createIndex('webhook_dlq', 'webhook_id')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('webhook_dlq')
}
