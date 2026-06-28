import type { Queryable } from './queryable.js'
import type { AuditChainVerificationState } from '../../services/audit/types.js'

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
      WHERE id = 'default'
      `,
    )

    if (result.rows.length === 0) {
      return null
    }

    const state = mapRow(result.rows[0])
    return state.status === 'never_run' && state.verifiedAt === null ? null : state
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const result = await this.db.query<StatusRow>(
      `
      UPDATE audit_chain_verification_status
      SET
        last_verified_height = $1,
        verified_at = $2,
        status = $3,
        first_break_seq = $4,
        violation_count = $5,
        rows_checked = $6,
        updated_at = NOW()
      WHERE id = 'default'
      RETURNING
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked
      `,
      [
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
    await this.db.query(
      `
      UPDATE audit_chain_verification_status
      SET
        last_verified_height = 0,
        verified_at = NULL,
        status = 'never_run',
        first_break_seq = NULL,
        violation_count = 0,
        rows_checked = 0,
        updated_at = NOW()
      WHERE id = 'default'
      `,
    )
  }
}

export class InMemoryAuditChainVerificationRepository implements AuditChainVerificationRepository {
  private state: AuditChainVerificationState | null = null

  async getStatus(): Promise<AuditChainVerificationState | null> {
    return this.state ? { ...this.state } : null
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    this.state = { ...state }
    return { ...this.state }
  }

  async clear(): Promise<void> {
    this.state = null
  }
}
