import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_active_identity ON bonds (identity_address) WHERE status = 'active'; -- Speeds up active subscription lookups per tenant");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP INDEX CONCURRENTLY IF EXISTS idx_bonds_active_identity;");
}
