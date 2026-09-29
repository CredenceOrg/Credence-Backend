import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: webhook_replay_audit
 *
 * Persists a durable, append-only record of every replay attempt on a DLQ
 * entry so operators can audit who triggered each replay, when, and what the
 * outcome was.  This is separate from the AuditLog service (which is in-memory
 * by default) so that replay history survives restarts and is query-able via
 * SQL.
 *
 * Idempotency: the UNIQUE index on (dlq_entry_id, idempotency_key) ensures
 * that concurrent or retried replay requests with the same key land only one
 * row — any duplicate INSERT is silently ignored by the route handler with
 * ON CONFLICT DO NOTHING.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('webhook_replay_audit', {
    id: { type: 'varchar(255)', primaryKey: true },
    dlq_entry_id: { type: 'varchar(255)', notNull: true },
    webhook_id: { type: 'varchar(255)', notNull: true },
    actor_id: { type: 'varchar(255)', notNull: true },
    actor_email: { type: 'varchar(255)', notNull: true },
    tenant_id: { type: 'varchar(255)', notNull: true },
    idempotency_key: { type: 'varchar(255)', notNull: true },
    replayed_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    success: { type: 'boolean', notNull: true },
    status_code: { type: 'integer' },
    error_message: { type: 'text' },
    ip_address: { type: 'varchar(64)' },
    request_id: { type: 'varchar(255)' },
  })

  // Fast look-ups by DLQ entry
  pgm.createIndex('webhook_replay_audit', 'dlq_entry_id')
  // Fast look-ups by actor for admin queries
  pgm.createIndex('webhook_replay_audit', 'actor_id')
  // Idempotency enforcement: one row per (entry, idempotency_key)
  pgm.createIndex('webhook_replay_audit', ['dlq_entry_id', 'idempotency_key'], {
    unique: true,
    name: 'uq_webhook_replay_audit_idempotency',
  })
  // Range scans for time-windowed audits
  pgm.createIndex('webhook_replay_audit', 'replayed_at')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('webhook_replay_audit')
}
