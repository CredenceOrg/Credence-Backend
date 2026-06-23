// Migration to create request_snapshots table
import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('request_snapshots', {
    request_id: { type: 'text', primaryKey: true },
    method: { type: 'text', notNull: true },
    path: { type: 'text', notNull: true },
    headers: { type: 'jsonb', notNull: true },
    body: { type: 'jsonb', notNull: true },
    snapshot: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('request_snapshots', 'created_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('request_snapshots');
}
