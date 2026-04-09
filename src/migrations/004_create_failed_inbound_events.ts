import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration 004: Create failed_inbound_events table
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('failed_inbound_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_type: {
      type: 'varchar(50)',
      notNull: true,
    },
    event_data: {
      type: 'jsonb',
      notNull: true,
    },
    failure_reason: {
      type: 'text',
    },
    replay_token: {
      type: 'varchar(100)',
      notNull: true,
      unique: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'failed',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  pgm.createIndex('failed_inbound_events', 'status')
  pgm.createIndex('failed_inbound_events', 'event_type')

  // Add trigger for updated_at
  pgm.sql(`
    CREATE TRIGGER update_failed_inbound_events_updated_at
      BEFORE UPDATE ON failed_inbound_events
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('failed_inbound_events')
}
