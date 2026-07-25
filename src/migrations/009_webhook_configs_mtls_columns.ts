import type { Pool } from 'pg';

/**
 * Migration: Add mTLS support columns to webhook_configs table.
 * 
 * This migration adds optional mutual TLS configuration fields to support
 * enterprise subscribers requiring client certificate authentication for
 * webhook delivery.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE webhook_configs
    ADD COLUMN IF NOT EXISTS client_cert_pem TEXT,
    ADD COLUMN IF NOT EXISTS client_key_kms_ref TEXT,
    ADD COLUMN IF NOT EXISTS pinned_server_cert_sha256 TEXT;

    COMMENT ON COLUMN webhook_configs.client_cert_pem IS 'PEM-encoded client certificate for mTLS authentication (optional)';
    COMMENT ON COLUMN webhook_configs.client_key_kms_ref IS 'KMS reference for client private key (optional, never stored as plaintext)';
    COMMENT ON COLUMN webhook_configs.pinned_server_cert_sha256 IS 'SHA256 hash of pinned server certificate for certificate pinning (optional)';
  `);
}

/**
 * Rollback: Remove mTLS columns from webhook_configs table.
 */
export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE webhook_configs
    DROP COLUMN IF EXISTS client_cert_pem,
    DROP COLUMN IF EXISTS client_key_kms_ref,
    DROP COLUMN IF EXISTS pinned_server_cert_sha256;
  `);
}