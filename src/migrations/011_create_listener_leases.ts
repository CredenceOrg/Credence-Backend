import type { Queryable } from '../db/repositories/queryable.js'

/**
 * Migration 011 — listener_leases
 *
 * Adds a leader-election + heartbeat row used by Horizon-style listeners so a
 * single primary instance owns a stream at any moment.  When the primary's
 * heartbeat goes stale the lease can be claimed by a standby, producing a
 * deterministic, gap-free handoff that is rehearsed by
 * `scripts/horizon-failover-drill.ts`.
 *
 * Security notes
 * --------------
 * Writes to this table MUST be performed by a service-role connection that has
 * **no** read access to the evidence tables (audit_logs, attestations,
 * settlements, …).  See docs/horizon-listener.md "Security" for the GRANT
 * statements applied at deploy time.
 */
export async function up(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS listener_leases (
      stream_name       TEXT        PRIMARY KEY,
      owner_id          TEXT        NOT NULL,
      paging_token      TEXT        NOT NULL DEFAULT '0',
      lease_expires_at  TIMESTAMPTZ NOT NULL,
      heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fencing_token     BIGINT      NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Fast standby-side probe: "is any lease currently expired?"
  await db.query(`
    CREATE INDEX IF NOT EXISTS listener_leases_expiry_idx
      ON listener_leases (lease_expires_at)
  `)

  // Per-owner lookups during graceful release.
  await db.query(`
    CREATE INDEX IF NOT EXISTS listener_leases_owner_idx
      ON listener_leases (owner_id)
  `)

  await db.query(`
    COMMENT ON TABLE listener_leases IS
      'Leader-election + heartbeat row for Horizon-style stream listeners. '
      'Write access is restricted to a dedicated service role that cannot '
      'read evidence tables.'
  `)
  await db.query(`
    COMMENT ON COLUMN listener_leases.fencing_token IS
      'Monotonic token. Bumped on every successful claim/steal. Workers must '
      'include their token on cursor writes so a zombie primary cannot '
      'overwrite a fresher cursor.'
  `)
}

/** Rollback: drop indexes then the table. */
export async function down(db: Queryable): Promise<void> {
  await db.query('DROP INDEX IF EXISTS listener_leases_owner_idx')
  await db.query('DROP INDEX IF EXISTS listener_leases_expiry_idx')
  await db.query('DROP TABLE  IF EXISTS listener_leases')
}
