import type { Pool } from 'pg'

/**
 * Migration 006: Add indexes for high-latency transaction queries
 *
 * ── Query plan verification ──────────────────────────────────────────────────
 * Run the following against a populated staging DB after applying this migration
 * to confirm Index Scan (not Seq Scan) appears in each plan.
 *
 * 1. idx_settlements_bond_settled_at
 *    Covers: SettlementsRepository.findByBondId
 *    Without index: Index Scan on idx_settlements_bond_id → Sort (external)
 *    Expected after:
 *      Index Scan using idx_settlements_bond_settled_at on settlements
 *        Index Cond: (bond_id = $1)
 *
 *    EXPLAIN (ANALYZE, BUFFERS)
 *    SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
 *    FROM settlements WHERE bond_id = $1 ORDER BY settled_at DESC, id DESC;
 *
 * 2. idx_settlements_transaction_hash
 *    Covers: SettlementsRepository.findByTransactionHash + upsert duplicate check
 *    Without index: Seq Scan on settlements (transaction_hash has no standalone index;
 *                   unique constraint is on (bond_id, transaction_hash))
 *    Expected after:
 *      Index Scan using idx_settlements_transaction_hash on settlements
 *        Index Cond: (transaction_hash = $1)
 *
 *    EXPLAIN (ANALYZE, BUFFERS)
 *    SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
 *    FROM settlements WHERE transaction_hash = $1;
 *
 * 3. idx_bonds_identity_created_at
 *    Covers: BondRepository.findByIdentityId ORDER BY created_at DESC
 *    Without index: Index Scan on identity_id → Sort
 *    Expected after:
 *      Index Scan using idx_bonds_identity_created_at on bonds
 *        Index Cond: (identity_id = $1)
 *
 *    EXPLAIN (ANALYZE, BUFFERS)
 *    SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
 *           bond_end, slashed_amount, active, created_at, updated_at
 *    FROM bonds WHERE identity_id = $1 ORDER BY created_at DESC;
 *
 * 4. idx_bonds_active_bond_end
 *    Covers: BondRepository.findExpired WHERE active = TRUE AND bond_end < NOW()
 *    Without index: Seq Scan with filter on active + bond_end
 *    Expected after:
 *      Index Scan using idx_bonds_active_bond_end on bonds
 *        Index Cond: (bond_end < now())
 *        (partial index predicate: active = TRUE already satisfied)
 *
 *    EXPLAIN (ANALYZE, BUFFERS)
 *    SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
 *           bond_end, slashed_amount, active, created_at, updated_at
 *    FROM bonds WHERE active = TRUE AND bond_end < NOW();
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    -- settlements: covering index for findByBondId sorted result set
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_settlements_bond_settled_at
      ON settlements (bond_id, settled_at DESC, id DESC);

    -- settlements: index for findByTransactionHash and upsert duplicate check
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_settlements_transaction_hash
      ON settlements (transaction_hash);

    -- bonds: covering index for findByIdentityId ORDER BY created_at DESC
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_identity_created_at
      ON bonds (identity_id, created_at DESC);

    -- bonds: partial index for findExpired (active bonds approaching/past bond_end)
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_active_bond_end
      ON bonds (bond_end)
      WHERE active = TRUE;
  `)
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_settlements_bond_settled_at;
    DROP INDEX CONCURRENTLY IF EXISTS idx_settlements_transaction_hash;
    DROP INDEX CONCURRENTLY IF EXISTS idx_bonds_identity_created_at;
    DROP INDEX CONCURRENTLY IF EXISTS idx_bonds_active_bond_end;
  `)
}
