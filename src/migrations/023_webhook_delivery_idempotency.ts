import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('webhook_delivery_keys', {
    id: { type: 'bigserial', primaryKey: true },
    subscriber_id: { type: 'varchar(255)', notNull: true },
    event_id: { type: 'varchar(255)', notNull: true },
    idempotency_key: { type: 'varchar(255)', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: 'now()' },
  })

  pgm.createIndex('webhook_delivery_keys', ['subscriber_id', 'event_id'], { unique: true })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('webhook_delivery_keys')
}
