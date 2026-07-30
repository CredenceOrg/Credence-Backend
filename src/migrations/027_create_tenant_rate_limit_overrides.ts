import type { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS tenant_rate_limit_overrides (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL UNIQUE,
      rate_limit INTEGER NOT NULL CHECK (rate_limit > 0),
      window_size INTEGER NOT NULL CHECK (window_size > 0),
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tenant_rate_limit_overrides_tenant_id ON tenant_rate_limit_overrides (tenant_id);
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS tenant_rate_limit_overrides;`)
}
