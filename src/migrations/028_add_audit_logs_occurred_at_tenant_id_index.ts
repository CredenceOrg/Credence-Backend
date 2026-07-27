import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: 028_add_audit_logs_occurred_at_tenant_id_index
 * 
 * Description: Index the audit log by occurred_at DESC, tenant_id to support
 * efficient sorted retrieval and tenant-scoped lookups.
 * 
 * Impact: Low. Creates a non-unique index.
 * Rollback: Drops the index.
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at_tenant_id ON audit_logs (occurred_at DESC, tenant_id);"
  )
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    "DROP INDEX IF EXISTS idx_audit_logs_occurred_at_tenant_id;"
  )
}