import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('feature_flags', {
    id: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), primaryKey: true },
    key: { type: 'text', notNull: true, unique: true },
    description: { type: 'text', notNull: true, default: '' },
    default_enabled: { type: 'boolean', notNull: true, default: false },
    rollout_percent: {
      type: 'integer',
      notNull: true,
      default: 0,
      check: 'rollout_percent >= 0 AND rollout_percent <= 100',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  })

  pgm.createTable('feature_flag_overrides', {
    id: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), primaryKey: true },
    flag_id: { type: 'uuid', notNull: true, references: 'feature_flags(id)', onDelete: 'CASCADE' },
    tenant_id: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  })

  pgm.addConstraint('feature_flag_overrides', 'uq_flag_overrides_flag_id_tenant_id', {
    unique: ['flag_id', 'tenant_id'],
  })

  pgm.createIndex('feature_flag_overrides', 'flag_id')
  pgm.createIndex('feature_flag_overrides', 'tenant_id')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('feature_flag_overrides')
  pgm.dropTable('feature_flags')
}
