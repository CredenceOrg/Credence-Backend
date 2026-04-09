import type { Queryable } from './queryable.js'

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
  constructor(private readonly db: Queryable) {}

  async upsert(input: CreateSettlementInput): Promise<UpsertSettlementResult> {
    const settledAt = input.settledAt ?? new Date()
    const status = input.status ?? 'pending'

    const exists = await this.db.query<{ id: number | string }>(
      `
      SELECT id
      FROM settlements
      WHERE bond_id = $1 AND transaction_hash = $2
      LIMIT 1
      `,
      [input.bondId, input.transactionHash],
    )

    const isDuplicate = exists.rows.length > 0

    const result = await this.db.query<SettlementRow>(
      `
      INSERT INTO settlements (bond_id, amount, transaction_hash, settled_at, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (bond_id, transaction_hash)
      DO UPDATE SET
        amount     = EXCLUDED.amount,
        status     = EXCLUDED.status,
        settled_at = EXCLUDED.settled_at,
        updated_at = NOW()
      RETURNING id, bond_id, amount, transaction_hash, settled_at, status,
                created_at, updated_at,
                (updated_at > created_at) AS is_duplicate
      `,
      [input.bondId, input.amount, input.transactionHash, settledAt, status],
    )

    const row = result.rows[0]
    return { settlement: mapSettlement(row), isDuplicate }
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
}
