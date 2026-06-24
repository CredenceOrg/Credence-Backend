import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('outbox_quarantine', {
    id: { type: 'bigserial', primaryKey: true },
    original_event_id: { type: 'bigint', notNull: true, unique: true },
    aggregate_type: { type: 'text', notNull: true },
    aggregate_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'text' },
    reason: { type: 'text', notNull: true },
    error_message: { type: 'text', notNull: true },
    retry_count: { type: 'integer', notNull: true, default: 0 },
    max_retries: { type: 'integer', notNull: true, default: 5 },
    quarantined_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    reinjected_at: { type: 'timestamptz' },
    reinjected_by: { type: 'text' },
  })

  pgm.addConstraint(
    'outbox_quarantine',
    'outbox_quarantine_reason_check',
    "CHECK (reason IN ('malformed_json', 'schema_invalid', 'oversized_payload', 'unknown_event_type'))"
  )
  pgm.createIndex('outbox_quarantine', ['reason', 'quarantined_at'])
  pgm.createIndex('outbox_quarantine', ['reinjected_at', 'quarantined_at'])
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('outbox_quarantine')
}
