import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('import_mapping_presets', {
    id: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), primaryKey: true },
    org_id: { type: 'uuid', notNull: true },
    name: { type: 'varchar(255)', notNull: true },
    version: { type: 'integer', notNull: true, default: 1 },
    column_mappings: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  })

  pgm.addConstraint('import_mapping_presets', 'uq_import_mapping_presets_org_name_version', {
    unique: ['org_id', 'name', 'version'],
  })

  pgm.createIndex('import_mapping_presets', 'org_id')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('import_mapping_presets')
}
