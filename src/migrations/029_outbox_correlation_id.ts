import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Adds an application-level correlation id column to the transactional
 * outbox, distinct from the existing OTel trace_id/span_id columns added in
 * 016_outbox_trace_context.ts. This lets the outbox publisher (and, in
 * turn, outbound webhook deliveries) restore the correlation id captured
 * from the originating HTTP request so a single request can be traced
 * end-to-end through async jobs and webhooks.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('event_outbox', {
    correlation_id: { type: 'text', notNull: false },
  })

  pgm.createIndex('event_outbox', 'correlation_id', {
    name: 'event_outbox_correlation_id_idx',
    where: 'correlation_id IS NOT NULL',
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('event_outbox', 'correlation_id', {
    name: 'event_outbox_correlation_id_idx',
  })
  pgm.dropColumn('event_outbox', 'correlation_id')
}
