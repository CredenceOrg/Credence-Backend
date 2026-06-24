import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Daily usage ledger – one row per org per day
  pgm.createTable('org_usage_daily', {
    id: { type: 'serial', primaryKey: true },
    org_id: { type: 'uuid', notNull: true },
    usage_date: { type: 'date', notNull: true },
    api_calls: { type: 'bigint', notNull: true, default: '0' },
    created_at: { type: 'timestamp', default: pgm.func('current_timestamp'), notNull: true },
  })
  pgm.addConstraint('org_usage_daily', 'uniq_org_date', { unique: ['org_id', 'usage_date'] })

  // Monthly rollup – one row per org per month
  pgm.createTable('org_usage_monthly', {
    id: { type: 'serial', primaryKey: true },
    org_id: { type: 'uuid', notNull: true },
    usage_month: { type: 'date', notNull: true }, // first day of month
    api_calls: { type: 'bigint', notNull: true, default: '0' },
    created_at: { type: 'timestamp', default: pgm.func('current_timestamp'), notNull: true },
    updated_at: { type: 'timestamp', default: pgm.func('current_timestamp'), notNull: true },
  })
  pgm.addConstraint('org_usage_monthly', 'uniq_org_month', { unique: ['org_id', 'usage_month'] })

  // Add default quota column to orgs table (if it exists)
  pgm.addColumn('orgs', {
    monthly_quota: { type: 'bigint', notNull: true, default: '1000000' },
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('org_usage_monthly')
  pgm.dropTable('org_usage_daily')
  pgm.dropColumn('orgs', 'monthly_quota')
}
