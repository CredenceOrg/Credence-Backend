import { MigrationBuilder } from 'node-pg-migrate';

/**
 * Migration: Add impersonation_tokens table
 *
 * Stores admin impersonation tokens with TTL and revocation support.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('impersonation_tokens', {
    token_id: { type: 'varchar', primaryKey: true },
    issued_by: { type: 'varchar', notNull: true },
    issued_by_email: { type: 'varchar', notNull: true },
    target_user_id: { type: 'varchar', notNull: true },
    target_user_email: { type: 'varchar', notNull: true },
    reason: { type: 'text', notNull: true },
    issued_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    expires_at: { type: 'timestamp', notNull: true },
    revoked: { type: 'boolean', notNull: true, default: false },
    revoked_at: { type: 'timestamp', notNull: false },
    revoked_by: { type: 'varchar', notNull: false },
  });

  // Index to efficiently purge expired and non‑revoked tokens (TTL cleanup)
  pgm.createIndex('impersonation_tokens', ['expires_at'], {
    where: 'revoked = false',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('impersonation_tokens');
}
