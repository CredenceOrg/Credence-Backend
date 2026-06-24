import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('event_outbox', {
    trace_id: { type: 'text', notNull: false },
    span_id: { type: 'text', notNull: false },
    tracestate: { type: 'text', notNull: false },
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('event_outbox', 'trace_id')
  pgm.dropColumn('event_outbox', 'span_id')
  pgm.dropColumn('event_outbox', 'tracestate')
}
