import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('event_outbox', {
    shard_count: { type: 'integer', notNull: false },
    shard_id: { type: 'integer', notNull: false },
  })

  // Indexes to speed up claim query on sharding columns
  pgm.addIndex('event_outbox', ['shard_count', 'shard_id', 'status'], {
    name: 'event_outbox_shard_idx',
    where: 'status = \'pending\' OR status = \'processing\'',
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('event_outbox', [], { name: 'event_outbox_shard_idx' })
  pgm.dropColumn('event_outbox', 'shard_count')
  pgm.dropColumn('event_outbox', 'shard_id')
}
