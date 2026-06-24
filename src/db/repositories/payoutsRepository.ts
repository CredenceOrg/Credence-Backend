import { randomUUID } from 'node:crypto'
import type { Queryable } from './queryable.js'

export interface Payout {
  id: string
  recipient: string
  amount: string
  currency: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface CreatePayoutInput {
  recipient: string
  amount: string
  currency?: string
  metadata?: Record<string, unknown>
}

export class PayoutsRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreatePayoutInput): Promise<Payout> {
    const id = randomUUID()
    const result = await this.db.query<{
      id: string
      recipient: string
      amount: string
      currency: string
      status: string
      metadata: Record<string, unknown>
      created_at: Date
      updated_at: Date
    }>(
      `
      INSERT INTO payouts (id, recipient, amount, currency, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING id, recipient, amount, currency, status, metadata, created_at, updated_at
      `,
      [
        id,
        input.recipient,
        input.amount,
        input.currency ?? 'USD',
        JSON.stringify(input.metadata ?? {}),
      ],
    )

    return mapRow(result.rows[0])
  }

  async findById(id: string): Promise<Payout | null> {
    const result = await this.db.query<{
      id: string
      recipient: string
      amount: string
      currency: string
      status: string
      metadata: Record<string, unknown>
      created_at: Date
      updated_at: Date
    }>(
      `SELECT id, recipient, amount, currency, status, metadata, created_at, updated_at
       FROM payouts WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }
}

function mapRow(row: {
  id: string
  recipient: string
  amount: string
  currency: string
  status: string
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}): Payout {
  return {
    id: row.id,
    recipient: row.recipient,
    amount: row.amount,
    currency: row.currency,
    status: row.status as Payout['status'],
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}
