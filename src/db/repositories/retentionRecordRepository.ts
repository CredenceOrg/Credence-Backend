import { randomUUID } from 'node:crypto'
import type { Queryable } from './queryable.js'

export interface CreateOrganizationEventRecordInput {
  organizationId: string
  eventName: string
  payload?: string | null
  createdAt?: Date
}

export interface CreateOrganizationAuditRecordInput {
  organizationId: string
  actorId: string
  action: string
  details?: string | null
  createdAt?: Date
}

interface CountRow {
  count: string
}

interface EventRow {
  id: string
  organization_id: string
  event_name: string
  payload: string | null
  created_at: Date | string
}

export class RetentionRecordRepository {
  constructor(private readonly db: Queryable) {}

  async createEventRecord(input: CreateOrganizationEventRecordInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO organization_event_records (id, organization_id, event_name, payload, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
      `,
      [
        randomUUID(),
        input.organizationId,
        input.eventName,
        input.payload ?? null,
        input.createdAt ?? null,
      ]
    )
  }

  async createAuditRecord(input: CreateOrganizationAuditRecordInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO organization_audit_records (id, organization_id, actor_id, action, details, created_at)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
      `,
      [
        randomUUID(),
        input.organizationId,
        input.actorId,
        input.action,
        input.details ?? null,
        input.createdAt ?? null,
      ]
    )
  }

  async archiveEligibleEventRecords(
    organizationId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<number> {
    const eligible = await this.db.query<EventRow>(
      `
      SELECT id, organization_id, event_name, payload, created_at
      FROM organization_event_records
      WHERE organization_id = $1
        AND created_at < $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3
      `,
      [organizationId, cutoff, batchSize]
    )

    if (eligible.rows.length === 0) {
      return 0
    }

    for (const row of eligible.rows) {
      await this.db.query(
        `
        INSERT INTO organization_event_record_archives (
          id,
          organization_id,
          event_name,
          payload,
          created_at,
          archived_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO NOTHING
        `,
        [row.id, row.organization_id, row.event_name, row.payload, row.created_at]
      )
    }

    const ids = eligible.rows.map((row) => row.id)
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ')
    const deleted = await this.db.query<CountRow>(
      `
      DELETE FROM organization_event_records
      WHERE id IN (${placeholders})
      RETURNING id::TEXT AS count
      `,
      ids
    )

    return deleted.rowCount ?? 0
  }

  async deleteEligibleAuditRecords(
    organizationId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<number> {
    const result = await this.db.query<CountRow>(
      `
      WITH eligible AS (
        SELECT id
        FROM organization_audit_records
        WHERE organization_id = $1
          AND created_at < $2
        ORDER BY created_at ASC, id ASC
        LIMIT $3
      ),
      deleted AS (
        DELETE FROM organization_audit_records
        WHERE id IN (SELECT id FROM eligible)
        RETURNING id
      )
      SELECT COUNT(*)::TEXT AS count
      FROM deleted
      `,
      [organizationId, cutoff, batchSize]
    )

    return Number(result.rows[0]?.count ?? '0')
  }

  async countEventRecords(organizationId: string): Promise<number> {
    const result = await this.db.query<CountRow>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM organization_event_records
      WHERE organization_id = $1
      `,
      [organizationId]
    )

    return Number(result.rows[0]?.count ?? '0')
  }

  async countArchivedEventRecords(organizationId: string): Promise<number> {
    const result = await this.db.query<CountRow>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM organization_event_record_archives
      WHERE organization_id = $1
      `,
      [organizationId]
    )

    return Number(result.rows[0]?.count ?? '0')
  }

  async countAuditRecords(organizationId: string): Promise<number> {
    const result = await this.db.query<CountRow>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM organization_audit_records
      WHERE organization_id = $1
      `,
      [organizationId]
    )

    return Number(result.rows[0]?.count ?? '0')
  }
}
