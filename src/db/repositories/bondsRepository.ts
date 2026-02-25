import type { Queryable } from './queryable.js'

export type BondStatus = 'active' | 'released' | 'slashed'

export interface Bond {
  id: number
  identityAddress: string
  amount: string
  startTime: Date
  durationDays: number
  status: BondStatus
  createdAt: Date
}

export interface CreateBondInput {
  identityAddress: string
  amount: string
  startTime: Date
  durationDays: number
  status?: BondStatus
}

type BondRow = {
  id: string | number
  identity_address: string
  amount: string
  start_time: Date | string
  duration_days: number
  status: BondStatus
  created_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapBond = (row: BondRow): Bond => ({
  id: Number(row.id),
  identityAddress: row.identity_address,
  amount: row.amount,
  startTime: toDate(row.start_time),
  durationDays: row.duration_days,
  status: row.status,
  createdAt: toDate(row.created_at),
})

export class BondsRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateBondInput): Promise<Bond> {
    const result = await this.db.query<BondRow>(
      `
      INSERT INTO bonds (identity_address, amount, start_time, duration_days, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, identity_address, amount, start_time, duration_days, status, created_at
      `,
      [
        input.identityAddress,
        input.amount,
        input.startTime,
        input.durationDays,
        input.status ?? 'active',
      ]
    )

    return mapBond(result.rows[0])
  }

  async findById(id: number): Promise<Bond | null> {
    const result = await this.db.query<BondRow>(
      `
      SELECT id, identity_address, amount, start_time, duration_days, status, created_at
      FROM bonds
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapBond(result.rows[0]) : null
  }

  async listByIdentity(identityAddress: string): Promise<Bond[]> {
    const result = await this.db.query<BondRow>(
      `
      SELECT id, identity_address, amount, start_time, duration_days, status, created_at
      FROM bonds
      WHERE identity_address = $1
      ORDER BY start_time DESC, id DESC
      `,
      [identityAddress]
    )

    return result.rows.map(mapBond)
  }

  async updateStatus(id: number, status: BondStatus): Promise<Bond | null> {
    const result = await this.db.query<BondRow>(
      `
      UPDATE bonds
      SET status = $2
      WHERE id = $1
      RETURNING id, identity_address, amount, start_time, duration_days, status, created_at
      `,
      [id, status]
    )

    return result.rows[0] ? mapBond(result.rows[0]) : null
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM bonds
      WHERE id = $1
      `,
      [id]
    )

    return (result.rowCount ?? 0) > 0
  }
}
