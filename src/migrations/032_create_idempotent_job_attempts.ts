import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: idempotent_job_attempts
 *
 * Durable idempotency guard for retryable background jobs — currently
 * notification/email delivery (see src/jobs/notificationIdempotency.ts).
 *
 * This table previously existed only in the test bootstrap schema
 * (src/db/schema.ts) and was never created by a migration, so the guard had no
 * table to write to in a migrated database. Every claim failed and each retry
 * of a notification job re-sent the email.
 *
 * Idempotency: the UNIQUE constraint on `job_key` alone is what makes the claim
 * atomic. The claim is a single
 *   INSERT ... ON CONFLICT (job_key) DO UPDATE ... WHERE <reclaimable> RETURNING
 * statement, so concurrent workers serialise on this index and only one gets a
 * RETURNING row. A composite unique key would break ON CONFLICT inference
 * (Postgres 42P10) and would also permit two live rows for the same job.
 *
 * Rows are swept once `expires_at` passes (see jobs/expiredSessionsSweeper.ts).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    'idempotent_job_attempts',
    {
      id: { type: 'text', primaryKey: true },
      job_key: { type: 'text', notNull: true },
      job_type: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      result: { type: 'text' },
      attempted_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      completed_at: { type: 'timestamptz' },
      expires_at: { type: 'timestamptz', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  )

  pgm.addConstraint('idempotent_job_attempts', 'idempotent_job_attempts_status_check', {
    check: "status IN ('pending', 'completed', 'failed')",
  })

  // Atomic-claim key: exactly one row per job_key.
  pgm.addConstraint('idempotent_job_attempts', 'idempotent_job_attempts_job_key_key', {
    unique: ['job_key'],
  })

  // Supports the expiry sweeper's range scan.
  pgm.createIndex('idempotent_job_attempts', 'expires_at', {
    name: 'idempotent_job_attempts_expires_at_idx',
    ifNotExists: true,
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('idempotent_job_attempts', { ifExists: true })
}
