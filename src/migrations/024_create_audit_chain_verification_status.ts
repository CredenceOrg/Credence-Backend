import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Durable storage for the audit chain verifier's last run result.
 * Operators query this via GET /api/admin/audit/chain-status.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('audit_chain_verification_status', {
    id: { type: 'varchar(32)', primaryKey: true },
    last_verified_height: { type: 'bigint', notNull: true, default: 0 },
    verified_at: { type: 'timestamptz' },
    status: { type: 'varchar(32)', notNull: true, default: 'never_run' },
    first_break_seq: { type: 'bigint' },
    violation_count: { type: 'integer', notNull: true, default: 0 },
    rows_checked: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: 'now()' },
  })

  pgm.sql(`
    INSERT INTO audit_chain_verification_status (id, status)
    VALUES ('default', 'never_run')
    ON CONFLICT (id) DO NOTHING
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('audit_chain_verification_status')
}
