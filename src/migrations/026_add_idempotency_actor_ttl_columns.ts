import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined

/**
 * Add actor_id and ttl_seconds columns to idempotency_keys table.
 *
 * actor_id   – binds the idempotency key to the calling actor (API key ID or
 *              user ID) so that a stolen key cannot be replayed by a different
 *              actor. Defaults to 'anonymous' for unauthenticated requests.
 *
 * ttl_seconds – records the TTL configured at write time so that the sweeper
 *               and monitoring can observe per-key retention windows.
 *               Default: 86400 (24 hours).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add actor_id column (NOT NULL with a safe default so existing rows survive)
  pgm.addColumn('idempotency_keys', {
    actor_id: {
      type: 'text',
      notNull: true,
      default: 'anonymous',
    },
  })

  // Add ttl_seconds column
  pgm.addColumn('idempotency_keys', {
    ttl_seconds: {
      type: 'integer',
      notNull: true,
      default: 86400,
    },
  })

  // Remove the column-level defaults now that the backfill is done; future
  // inserts must always supply an explicit value.
  pgm.alterColumn('idempotency_keys', 'actor_id', { default: null })
  pgm.alterColumn('idempotency_keys', 'ttl_seconds', { default: null })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('idempotency_keys', 'actor_id')
  pgm.dropColumn('idempotency_keys', 'ttl_seconds')
}
