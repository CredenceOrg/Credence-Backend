import type { Pool } from 'pg'

/**
 * Migration 010: Add hash-chain columns to audit_logs for tamper detection.
 *
 * Each row stores:
 *   - prev_hash: SHA-256 row_hash of the immediately preceding row (NULL for the genesis row)
 *   - row_hash:  SHA-256( prev_hash || id || occurred_at || actor_id || action || resource_type || resource_id || details_json || status || tenant_id )
 *
 * A sequence `audit_logs_seq` is used to establish a deterministic total order
 * even when multiple rows share the same `occurred_at` timestamp.
 *
 * The application layer is responsible for computing and inserting the hashes
 * inside the same serialised transaction that inserts the row.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    -- 1. Add a sequence for deterministic ordering
    CREATE SEQUENCE IF NOT EXISTS audit_logs_seq;

    -- 2. Add a sequence number column with a default from the sequence
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('audit_logs_seq');

    -- 3. Add hash chain columns
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS prev_hash TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS row_hash  TEXT DEFAULT NULL;

    -- 4. Index for efficient chain walking (ordered scans)
    CREATE INDEX IF NOT EXISTS idx_audit_logs_seq ON audit_logs (seq ASC);

    -- 5. Unique constraint on seq to prevent duplicates
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_seq_unique UNIQUE (seq);

    -- 6. Backfill existing rows: compute hashes in sequence order.
    --    For existing data the genesis row gets prev_hash = NULL.
    DO $$
    DECLARE
      r RECORD;
      prev TEXT := NULL;
      computed TEXT;
    BEGIN
      FOR r IN
        SELECT id, occurred_at, actor_id, action, resource_type, resource_id,
               COALESCE(details_json::text, '{}') AS details_text,
               status, tenant_id, seq
          FROM audit_logs
         ORDER BY seq ASC
      LOOP
        computed := encode(
          sha256(
            convert_to(
              COALESCE(prev, 'GENESIS') || '|' ||
              r.id || '|' ||
              r.occurred_at::text || '|' ||
              r.actor_id || '|' ||
              r.action || '|' ||
              r.resource_type || '|' ||
              r.resource_id || '|' ||
              r.details_text || '|' ||
              r.status || '|' ||
              r.tenant_id,
              'UTF8'
            )
          ),
          'hex'
        );
        UPDATE audit_logs SET prev_hash = prev, row_hash = computed WHERE id = r.id;
        prev := computed;
      END LOOP;
    END $$;
  `)
}

/**
 * Rollback: remove hash-chain columns and the ordering sequence.
 */
export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE audit_logs
      DROP COLUMN IF EXISTS row_hash,
      DROP COLUMN IF EXISTS prev_hash,
      DROP COLUMN IF EXISTS seq;
    DROP SEQUENCE IF EXISTS audit_logs_seq;
  `)
}
