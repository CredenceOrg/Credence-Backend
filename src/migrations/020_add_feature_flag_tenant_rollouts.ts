import type { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration 020 – per-tenant rollout percentages for feature flags.
 *
 * This is an ADDITIVE migration: the existing `feature_flag_overrides` table
 * (which stores boolean on/off overrides) is left completely untouched so that
 * all callers of the existing API continue to work without modification.
 *
 * A brand-new table `feature_flag_tenant_rollouts` stores a per-tenant
 * rollout percentage.  The evaluation precedence (high → low) is:
 *
 *   1. feature_flag_overrides   (boolean on/off — highest priority)
 *   2. feature_flag_tenant_rollouts  (per-tenant %)
 *   3. feature_flags.rollout_percent (global %)
 *   4. feature_flags.default_enabled (fallback)
 *
 * Rollout bucketing in layers 2 and 3 uses the same deterministic
 * SHA-256(flagKey:userId) hash, ensuring sticky bucketing across all layers.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('feature_flag_tenant_rollouts', {
    id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('gen_random_uuid()'),
      primaryKey: true,
    },
    flag_id: {
      type: 'uuid',
      notNull: true,
      references: 'feature_flags(id)',
      onDelete: 'CASCADE',
    },
    tenant_id: { type: 'text', notNull: true },
    rollout_percent: {
      type: 'integer',
      notNull: true,
      check: 'rollout_percent >= 0 AND rollout_percent <= 100',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // One rollout percentage per (flag, tenant) pair – upsert semantics.
  pgm.addConstraint(
    'feature_flag_tenant_rollouts',
    'uq_ff_tenant_rollouts_flag_id_tenant_id',
    { unique: ['flag_id', 'tenant_id'] },
  )

  pgm.createIndex('feature_flag_tenant_rollouts', 'flag_id')
  pgm.createIndex('feature_flag_tenant_rollouts', 'tenant_id')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('feature_flag_tenant_rollouts')
}
