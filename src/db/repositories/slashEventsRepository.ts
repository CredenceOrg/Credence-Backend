import type { Queryable } from './queryable.js'

export interface SlashEvent {
  id: number
  bondId: number
  slashAmount: string
  reason: string
  createdAt: Date
}

export interface CreateSlashEventInput {
  bondId: number
  slashAmount: string
  reason: string
}

type SlashEventRow = {
  id: string | number
  bond_id: string | number
  slash_amount: string
  reason: string
  created_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapSlashEvent = (row: SlashEventRow): SlashEvent => ({
  id: Number(row.id),
  bondId: Number(row.bond_id),
  slashAmount: row.slash_amount,
  reason: row.reason,
  createdAt: toDate(row.created_at),
})

export class SlashEventsRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateSlashEventInput): Promise<SlashEvent> {
    const result = await this.db.query<SlashEventRow>(
      `
      INSERT INTO slash_events (bond_id, slash_amount, reason)
      VALUES ($1, $2, $3)
      RETURNING id, bond_id, slash_amount, reason, created_at
      `,
      [input.bondId, input.slashAmount, input.reason]
    )

    return mapSlashEvent(result.rows[0])
  }

  async findById(id: number): Promise<SlashEvent | null> {
    const result = await this.db.query<SlashEventRow>(
      `
      SELECT id, bond_id, slash_amount, reason, created_at
      FROM slash_events
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapSlashEvent(result.rows[0]) : null
  }

  async listByBond(bondId: number): Promise<SlashEvent[]> {
    const result = await this.db.query<SlashEventRow>(
      `
      SELECT id, bond_id, slash_amount, reason, created_at
      FROM slash_events
      WHERE bond_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [bondId]
    )

    return result.rows.map(mapSlashEvent)
  }

  async totalSlashedForBond(bondId: number): Promise<string> {
    const result = await this.db.query<{ total: string | null }>(
      `
      SELECT COALESCE(SUM(slash_amount)::TEXT, '0') AS total
      FROM slash_events
      WHERE bond_id = $1
      `,
      [bondId]
    )

    return result.rows[0]?.total ?? '0'
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM slash_events
      WHERE id = $1
      `,
      [id]
    )

    return (result.rowCount ?? 0) > 0
  }
}
