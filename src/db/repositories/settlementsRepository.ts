import type { Pool } from 'pg'
import type { Queryable } from './queryable.js'
import { TransactionManager } from '../transaction.js'

export type SettlementStatus = 'pending' | 'settled' | 'failed'

export interface Settlement {
  id: string
  bondId: string
  amount: string
  transactionHash: string
  settledAt: Date
  status: SettlementStatus
  createdAt: Date
  updatedAt: Date
}

export interface CreateSettlementInput {
  bondId: string | number
  amount: string
  transactionHash: string
  settledAt?: Date
  status?: SettlementStatus
}

export interface UpsertSettlementResult {
  settlement: Settlement
  isDuplicate: boolean
}

type SettlementRow = {
  id: string | number
  bond_id: string | number
  amount: string
  transaction_hash: string
  settled_at: Date | string
  status: SettlementStatus
  created_at: Date | string
  updated_at: Date | string
  is_duplicate?: boolean
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapSettlement = (row: SettlementRow): Settlement => ({
  id: String(row.id),
  bondId: String(row.bond_id),
  amount: row.amount,
  transactionHash: row.transaction_hash,
  settledAt: toDate(row.settled_at),
  status: row.status,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export class SettlementsRepository {
  private readonly txManager?: TransactionManager

  /**
   * @param db   - A `Queryable` (Pool or PoolClient) for read/write queries.
   * @param pool - The underlying `Pool`; required for `upsertBatch()` which
   *               needs an exclusive client and TransactionManager hooks.
   */
  constructor(private readonly db: Queryable, private readonly pool?: Pool) {
    if (pool) {
      this.txManager = new TransactionManager(pool)
    }
  }

  async upsert(input: CreateSettlementInput): Promise<UpsertSettlementResult> {
    return this._upsert(this.db, input)
  }

  async upsertBatch(inputs: CreateSettlementInput[]): Promise<UpsertSettlementResult[]> {
    // If a pool-backed TransactionManager is available, use it so post-commit
    // hooks (cache invalidation, metrics) fire correctly and rollback hooks
    // can compensate on partial failure. This also eliminates the manual
    // BEGIN/COMMIT path that bypassed the hook mechanism.
    if (this.txManager) {
      return this.txManager.withTransaction(async (client) => {
        const results: UpsertSettlementResult[] = []
        for (const input of inputs) {
          const res = await this._upsert(client, input)
          results.push(res)
        }
        return results
      })
    }

    // Fallback: no pool configured, work with whatever db was given.
    // If db is itself a PoolClient already inside a transaction, this is
    // a nested call that shares the outer transaction — correct.
    // If db is a Pool without TransactionManager, we cannot guarantee
    // atomicity of the batch; callers should supply a pool.
    const results: UpsertSettlementResult[] = []
    for (const input of inputs) {
      const res = await this._upsert(this.db, input)
      results.push(res)
    }
    return results
  }

  private async _upsert(db: Queryable, input: CreateSettlementInput): Promise<UpsertSettlementResult> {
    const settledAt = input.settledAt ?? new Date()
    const status = input.status ?? 'pending'

    // Atomic upsert: use xmax to detect whether the row was freshly inserted
    // (xmax = 0) or updated due to an ON CONFLICT hit (xmax > 0).
    //
    // The previous two-step SELECT + INSERT pattern was a TOCTOU race:
    // between the SELECT and the INSERT a concurrent writer could insert the
    // same transaction_hash, making both writers believe they are the first.
    // This single-statement form eliminates that race entirely.
    const result = await db.query<SettlementRow & { xmax: string }>(
      `INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (transaction_hash)
       DO UPDATE SET
         amount     = EXCLUDED.amount,
         status     = EXCLUDED.status,
         settled_at = EXCLUDED.settled_at,
         updated_at = NOW()
       RETURNING id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at,
                 xmax::text AS xmax`,
      [input.bondId, input.amount, input.transactionHash, settledAt, status],
    )

    // xmax = '0' → fresh insert (no prior conflict row); anything else → updated existing row.
    const isDuplicate = result.rows[0].xmax !== '0'

    return { settlement: mapSettlement(result.rows[0]), isDuplicate }
  }

  async findById(id: string | number): Promise<Settlement | null> {
    const result = await this.db.query<SettlementRow>(
      `
      SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
      FROM settlements
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapSettlement(result.rows[0]) : null
  }

  async findByBondId(bondId: string | number): Promise<Settlement[]> {
    const result = await this.db.query<SettlementRow>(
      `
      SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
      FROM settlements
      WHERE bond_id = $1
      ORDER BY settled_at DESC, id DESC
      `,
      [bondId]
    )

    return result.rows.map(mapSettlement)
  }

  async findByTransactionHash(transactionHash: string): Promise<Settlement | null> {
    const result = await this.db.query<SettlementRow>(
      `
      SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
      FROM settlements
      WHERE transaction_hash = $1
      `,
      [transactionHash]
    )

    return result.rows[0] ? mapSettlement(result.rows[0]) : null
  }

  async countByBondId(bondId: string | number): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM settlements
      WHERE bond_id = $1
      `,
      [bondId]
    )

    return parseInt(result.rows[0]?.count ?? '0', 10)
  }

  async delete(id: string | number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM settlements
      WHERE id = $1
      `,
      [id]
    )

    return (result.rowCount ?? 0) > 0
  }

  async findManyPaginated(params: {
    limit: number
    cursor?: { t: string; i: string }
    bondId?: string
  }): Promise<Settlement[]> {
    const { limit, cursor, bondId } = params
    const values: any[] = [limit]
    let whereClause = ''
    let paramIndex = 2

    if (bondId) {
      whereClause = `WHERE bond_id = $${paramIndex++}`
      values.push(bondId)
    }

    if (cursor) {
      const prefix = whereClause ? 'AND' : 'WHERE'
      whereClause += ` ${prefix} (settled_at, id) < ($${paramIndex}, $${paramIndex + 1})`
      values.push(cursor.t, cursor.i)
    }

    const query = `
      SELECT id, bond_id, amount, transaction_hash, settled_at, status, created_at, updated_at
      FROM settlements
      ${whereClause}
      ORDER BY settled_at DESC, id DESC
      LIMIT $1
    `

    const result = await this.db.query<SettlementRow>(query, values)
    return result.rows.map(mapSettlement)
  }
}
