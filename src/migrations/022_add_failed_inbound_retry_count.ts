import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('failed_inbound_events', {
    retry_count: {
      type: 'smallint',
      notNull: true,
      default: 0,
    },
    last_retried_at: {
      type: 'timestamp',
    },
  })

  pgm.sql(`
    UPDATE failed_inbound_events
    SET retry_count = 0
    WHERE retry_count IS NULL
  `)

  pgm.createIndex('failed_inbound_events', 'retry_count')
  pgm.createIndex('failed_inbound_events', 'last_retried_at')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('failed_inbound_events', ['retry_count', 'last_retried_at'])
}
