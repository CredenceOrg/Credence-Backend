import { randomUUID } from 'node:crypto'
import type { Queryable } from './queryable.js'

export type RetentionRecordClass = 'event' | 'audit'
export type RetentionDisposition = 'archive' | 'delete'

export interface RetentionPolicy {
  id: string
  organizationId: string | null
  recordClass: RetentionRecordClass
  retentionDays: number
  disposition: RetentionDisposition
  createdAt: Date
  updatedAt: Date
}

export interface RetentionPolicyChange {
  id: string
  organizationId: string | null
  recordClass: RetentionRecordClass
  previousRetentionDays: number | null
  previousDisposition: RetentionDisposition | null
  newRetentionDays: number
  newDisposition: RetentionDisposition
  changedBy: string
  reason: string | null
  createdAt: Date
}

export interface UpsertRetentionPolicyInput {
  organizationId?: string | null
  recordClass: RetentionRecordClass
  retentionDays: number
  disposition: RetentionDisposition
  changedBy: string
  reason?: string
}

interface RetentionPolicyRow {
  id: string
  organization_id: string | null
  record_class: RetentionRecordClass
  retention_days: number
  disposition: RetentionDisposition
  created_at: Date | string
  updated_at: Date | string
}

interface RetentionPolicyChangeRow {
  id: string
  organization_id: string | null
  record_class: RetentionRecordClass
  previous_retention_days: number | null
  previous_disposition: RetentionDisposition | null
  new_retention_days: number
  new_disposition: RetentionDisposition
  changed_by: string
  reason: string | null
  created_at: Date | string
}

const GLOBAL_SCOPE_KEY = '__global__'

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapPolicy = (row: RetentionPolicyRow): RetentionPolicy => ({
  id: row.id,
  organizationId: row.organization_id,
  recordClass: row.record_class,
  retentionDays: Number(row.retention_days),
  disposition: row.disposition,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

const mapChange = (row: RetentionPolicyChangeRow): RetentionPolicyChange => ({
  id: row.id,
  organizationId: row.organization_id,
  recordClass: row.record_class,
  previousRetentionDays:
    row.previous_retention_days === null ? null : Number(row.previous_retention_days),
  previousDisposition: row.previous_disposition,
  newRetentionDays: Number(row.new_retention_days),
  newDisposition: row.new_disposition,
  changedBy: row.changed_by,
  reason: row.reason,
  createdAt: toDate(row.created_at),
})

export class RetentionPolicyRepository {
  constructor(private readonly db: Queryable) {}

  async upsertPolicy(input: UpsertRetentionPolicyInput): Promise<RetentionPolicy> {
    const organizationId = input.organizationId ?? null
    const scopeKey = organizationId ?? GLOBAL_SCOPE_KEY
    const previous = await this.findPolicyByScope(organizationId, input.recordClass)
    const newPolicyId = randomUUID()

    const policyResult = await this.db.query<RetentionPolicyRow>(
      `
      INSERT INTO retention_policies (
        id,
        organization_id,
        scope_key,
        record_class,
        retention_days,
        disposition
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (scope_key, record_class)
      DO UPDATE SET
        retention_days = EXCLUDED.retention_days,
        disposition = EXCLUDED.disposition,
        updated_at = NOW()
      RETURNING id, organization_id, record_class, retention_days, disposition, created_at, updated_at
      `,
      [
        newPolicyId,
        organizationId,
        scopeKey,
        input.recordClass,
        input.retentionDays,
        input.disposition,
      ]
    )

    await this.db.query(
      `
      INSERT INTO retention_policy_changes (
        id,
        organization_id,
        record_class,
        previous_retention_days,
        previous_disposition,
        new_retention_days,
        new_disposition,
        changed_by,
        reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        organizationId,
        input.recordClass,
        previous?.retentionDays ?? null,
        previous?.disposition ?? null,
        input.retentionDays,
        input.disposition,
        input.changedBy,
        input.reason ?? null,
      ]
    )

    return mapPolicy(policyResult.rows[0])
  }

  async findPolicyByScope(
    organizationId: string | null,
    recordClass: RetentionRecordClass
  ): Promise<RetentionPolicy | null> {
    const scopeKey = organizationId ?? GLOBAL_SCOPE_KEY
    const result = await this.db.query<RetentionPolicyRow>(
      `
      SELECT id, organization_id, record_class, retention_days, disposition, created_at, updated_at
      FROM retention_policies
      WHERE scope_key = $1
        AND record_class = $2
      `,
      [scopeKey, recordClass]
    )

    return result.rows[0] ? mapPolicy(result.rows[0]) : null
  }

  async resolvePolicy(
    organizationId: string,
    recordClass: RetentionRecordClass
  ): Promise<RetentionPolicy | null> {
    const result = await this.db.query<RetentionPolicyRow>(
      `
      SELECT id, organization_id, record_class, retention_days, disposition, created_at, updated_at
      FROM retention_policies
      WHERE record_class = $2
        AND scope_key IN ($1, $3)
      ORDER BY CASE WHEN scope_key = $1 THEN 0 ELSE 1 END
      LIMIT 1
      `,
      [organizationId, recordClass, GLOBAL_SCOPE_KEY]
    )

    return result.rows[0] ? mapPolicy(result.rows[0]) : null
  }

  async listPolicyChanges(
    organizationId?: string | null
  ): Promise<RetentionPolicyChange[]> {
    const result = organizationId === undefined
      ? await this.db.query<RetentionPolicyChangeRow>(
          `
          SELECT id, organization_id, record_class, previous_retention_days, previous_disposition,
                 new_retention_days, new_disposition, changed_by, reason, created_at
          FROM retention_policy_changes
          ORDER BY created_at DESC, id DESC
          `
        )
      : organizationId === null
        ? await this.db.query<RetentionPolicyChangeRow>(
            `
            SELECT id, organization_id, record_class, previous_retention_days, previous_disposition,
                   new_retention_days, new_disposition, changed_by, reason, created_at
            FROM retention_policy_changes
            WHERE organization_id IS NULL
            ORDER BY created_at DESC, id DESC
            `
          )
        : await this.db.query<RetentionPolicyChangeRow>(
            `
            SELECT id, organization_id, record_class, previous_retention_days, previous_disposition,
                   new_retention_days, new_disposition, changed_by, reason, created_at
            FROM retention_policy_changes
            WHERE organization_id = $1
            ORDER BY created_at DESC, id DESC
            `,
            [organizationId]
          )

    return result.rows.map(mapChange)
  }
}
