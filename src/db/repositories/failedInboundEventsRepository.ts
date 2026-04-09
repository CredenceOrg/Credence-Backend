import { Queryable } from './queryable.js'
import { v4 as uuidv4 } from 'uuid'

export type FailedEventStatus = 'failed' | 'replayed' | 'skipped'

export interface FailedInboundEvent {
  id: string
  eventType: string
  eventData: any
  failureReason?: string
  replayToken: string
  status: FailedEventStatus
  createdAt: Date
  updatedAt: Date
}

export interface CreateFailedEventInput {
  eventType: string
  eventData: any
  failureReason?: string
  replayToken?: string
}

type FailedEventRow = {
  id: string
  event_type: string
  event_data: any
  failure_reason?: string
  replay_token: string
  status: FailedEventStatus
  created_at: Date | string
  updated_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapFailedEvent = (row: FailedEventRow): FailedInboundEvent => ({
  id: row.id,
  eventType: row.event_type,
  eventData: typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data,
  failureReason: row.failure_reason,
  replayToken: row.replay_token,
  status: row.status,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export class FailedInboundEventsRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateFailedEventInput): Promise<FailedInboundEvent> {
    const replayToken = input.replayToken || uuidv4()
    const result = await this.db.query<FailedEventRow>(
      `
      INSERT INTO failed_inbound_events (event_type, event_data, failure_reason, replay_token, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at
      `,
      [input.eventType, JSON.stringify(input.eventData), input.failureReason, replayToken, 'failed']
    )

    return mapFailedEvent(result.rows[0])
  }

  async findById(id: string): Promise<FailedInboundEvent | undefined> {
    const result = await this.db.query<FailedEventRow>(
      `
      SELECT id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at
      FROM failed_inbound_events
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapFailedEvent(result.rows[0]) : undefined
  }

  async updateStatus(id: string, status: FailedEventStatus): Promise<void> {
    await this.db.query(
      `
      UPDATE failed_inbound_events
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [status, id]
    )
  }

  async list(filters: { status?: FailedEventStatus; type?: string }, limit = 50, offset = 0): Promise<{ events: FailedInboundEvent[], total: number }> {
    let whereClause = ''
    const params: any[] = []

    if (filters.status) {
      params.push(filters.status)
      whereClause += `WHERE status = $${params.length} `
    }

    if (filters.type) {
      params.push(filters.type)
      whereClause += whereClause ? 'AND ' : 'WHERE '
      whereClause += `event_type = $${params.length} `
    }

    const eventsResult = await this.db.query<FailedEventRow>(
      `
      SELECT id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at
      FROM failed_inbound_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, limit, offset]
    )

    const countResult = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM failed_inbound_events
      ${whereClause}
      `,
      params
    )

    return {
      events: eventsResult.rows.map(mapFailedEvent),
      total: parseInt(countResult.rows[0]?.count ?? '0', 10)
    }
  }
}
