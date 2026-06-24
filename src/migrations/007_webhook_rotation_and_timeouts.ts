import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('webhook_configs', {
    previous_secret: { type: 'varchar(255)', notNull: false },
    timeout_ms: { type: 'integer', notNull: true, default: 5000 },
    max_attempts: { type: 'integer', notNull: true, default: 3 },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('webhook_configs', ['previous_secret', 'timeout_ms', 'max_attempts']);
}
