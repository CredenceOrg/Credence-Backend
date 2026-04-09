import type { Pool } from 'pg';

/**
 * Migration: Create webhook_configs table for persistent webhook management.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      url                TEXT          NOT NULL,
      secret             TEXT          NOT NULL,
      previous_secret    TEXT,
      secret_updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      active             BOOLEAN       NOT NULL DEFAULT TRUE,
      events             TEXT[]        NOT NULL,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_configs_active ON webhook_configs(active);
  `);
}

/**
 * Rollback: Drop webhook_configs table.
 */
export async function down(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS webhook_configs;');
}
