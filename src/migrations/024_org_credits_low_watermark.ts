import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('org_credits', {
    low_credit_threshold: {
      type: 'bigint',
      notNull: false,
      comment: 'Per-org low-credit webhook threshold; null uses the global default',
    },
    low_credit_alert_armed: {
      type: 'boolean',
      notNull: true,
      default: true,
      comment: 'When false, credits.low webhook is suppressed until credits recover above threshold',
    },
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('org_credits', 'low_credit_alert_armed')
  pgm.dropColumn('org_credits', 'low_credit_threshold')
}
