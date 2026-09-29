import type { Queryable } from './queryable.js'
import type { AuditChainVerificationState } from '../../services/audit/types.js'
import { getTenantId } from '../../utils/tenantContext.js'

export interface AuditChainVerificationRepository {
  getStatus(): Promise<AuditChainVerificationState | null>
  saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState>
  clear(): Promise<void>
}

type StatusRow = {
  last_verified_height: string | number
  verified_at: Date | string | null
  status: string
  first_break_seq: string | number | null
  violation_count: number
  rows_checked: number
}

function mapRow(row: StatusRow): AuditChainVerificationState {
  return {
    lastVerifiedHeight: Number(row.last_verified_height),
    verifiedAt: row.verified_at
      ? (row.verified_at instanceof Date
          ? row.verified_at.toISOString()
          : String(row.verified_at))
      : null,
    status: row.status as AuditChainVerificationState['status'],
    firstBreakSeq: row.first_break_seq !== null ? Number(row.first_break_seq) : null,
    violationCount: row.violation_count,
    rowsChecked: row.rows_checked,
  }
}

export class PostgresAuditChainVerificationRepository implements AuditChainVerificationRepository {
  constructor(private readonly db: Queryable) {}

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    const result = await this.db.query<StatusRow>(
      `
      SELECT
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked
      FROM audit_chain_verification_status
      WHERE id = $1
      `,
      [tenantId],
    )

    if (result.rows.length === 0) {
      return null
    }

    const state = mapRow(result.rows[0])
    return state.status === 'never_run' && state.verifiedAt === null ? null : state
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    const result = await this.db.query<StatusRow>(
      `
      INSERT INTO audit_chain_verification_status *
        id,
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW)
      ON CONFLICT (id) DU UPDATE SET
        last_verified_height = EXCLUDED.last_verified_height,
        verified_at = EXCLUDED.verified_at,
        status = EXCLUDED.status,
        first_break_seq = EXCLUDED.first_break_seq,
        violation_count = EXCLUDED.violation_count,
        rows_checked = EXCLUDED.rows_checked,
        updated_at = NOW()
      RETURNING
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked
      `,
      [
        tenantId,
        state.lastVerifiedHeight,
        state.verifiedAt,
        state.status,
        state.firstBreakSeq ?? null,
        state.violationCount ?? 0,
        state.rowsChecked ?? 0,
      ],
    )

    return mapRow(result.rows[0])
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    await this.db.query(
      `\n      UPDATE audit_chain_verification_status\n      SET\n        last_verified_height = 0,\n        verified_at = NULL,\n        status = 'never_run',\n        first_break_seq = NULL,\n        violation_count = 0,\n        rows_checked = 0,\n        updated_at = NOW()\n      WHERE id = $1\n      `,\n      [tenantId],
    )
  }
}

export class InMemoryAuditChainVerificationRepository implements AuditChainVerificationRepository {
  private states = new Map<string, AuditChainVerificationState>()

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    const state = this.states.get(tenantId)
    return state ? { ...state } : null
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    this.states.set(tenantId, { ...state })
    return { ...this.states.get(tenantId)! }
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    this.states.delete(tenantId)
  }
}
