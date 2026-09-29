import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: add webhook_configs.previous_secret_expires_at
 *
 * `PostgresWebhookRepository.rotateSecret()` (src/db/repositories/webhookRepository.ts)
 * and `WebhookRotationService` (src/services/webhooks/rotationService.ts) have relied
 * on this column since the safe-rollout secret rotation endpoint was written, but no
 * migration ever created it — rotation against a real Postgres-backed store would fail
 * with "column previous_secret_expires_at does not exist". This column stores the
 * explicit ISO timestamp (set at rotation time, 24h TTL) after which `previous_secret`
 * should no longer be accepted for signature verification.
 *
 * Nullable, no default: existing rows have no previous secret to expire.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('webhook_configs', {
    previous_secret_expires_at: { type: 'timestamptz', notNull: false },
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('webhook_configs', ['previous_secret_expires_at'])
}
