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

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

function toSafeInteger(value: unknown, field: string): number {
  if (value === null || value === undefined) {
    throw new Error(`Invalid ${field}: value is required`)
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Invalid ${field}: expected a safe integer`)
  }
  return numeric
}

function toSafeIntegerOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null
  }
  return toSafeInteger(value, field)
}

function normalizeVerifiedAt(value: Date | string | null): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid verifiedAt: invalid Date')
    }
    return value.toISOString()
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid verifiedAt: unparseable timestamp')
  }
  return parsed.toISOString()
}

function mapRow(row: StatusRow): AuditChainVerificationState {
  return {
    lastVerifiedHeight: toSafeInteger(row.last_verified_height, 'last_verified_height'),
    verifiedAt: normalizeVerifiedAt(row.verified_at),
    status: row.status as AuditChainVerificationState['status'],
    firstBreakSeq: toSafeIntegerOrNull(row.first_break_seq, 'first_break_seq'),
    violationCount: toSafeInteger(row.violation_count, 'violation_count'),
    rowsChecked: toSafeInteger(rows.rows_checked, 'rows_checked'),
  }
}

function validateState(state: AuditChainVerificationState): AuditChainVerificationState {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid audit chain verification state')
  }

  const lastVerifiedHeight = toSafeInteger(state.lastVerifiedHeight, 'lastVerifiedHeight')
  if (lastVerifiedHeight < 0) {
    throw new Error('Invalid lastVerifiedHeight: must be non-negative')
  }

  const violationCount = toSafeInteger(state.violationCount ?? 0, 'violationCount')
  if (violationCount < 0) {
    throw new Error('Invalid violationCount: must be non-negative')
  }

  const rowsChecked = toSafeInteger(state.rowsChecked ?? 0, 'rowsChecked')
  if (rowsChecked < 0) {
    throw new Error('Invalid rowsChecked: must be non-negative')
  }

  const firstBreakSeq = toSafeIntegerOrNull(state.firstBreakSeq ?? null, 'firstBreakSeq')
  if (firstBreakSeq !== null && firstBreakSeq < 0) {
    throw new Error('Invalid firstBreakSeq: must be non-negative')
  }

  const verifiedAt = normalizeVerifiedAt(state.verifiedAt)

  if (state.status === 'violation' && firstBreakSeq === null) {
    throw new Error('Invalid state: violation status requires firstBreakSeq')
  }

  if (state.status === 'violation' && violationCount < 1) {
    throw new Error('Invalid state: violation status requires violationCount >= 1')
  }

  if (state.status === 'never_run' && verifiedAt !== null) {
    throw new Error('Invalid state: never_run cannot have a verifiedAt timestamp')
  }

  return {
    lastVerifiedHeight,
    verifiedAt,
    status: state.status,
    firstBreakSeq,
    violationCount,
    rowsChecked,
  }
}

function cloneState(state: AuditChainVerificationState): AuditChainVerificationState {
  return { ...state }
}

export class PostgresAuditChainVerificationRepository implements AuditChainVerificationRepository {
  constructor(private readonly db: Queryable) {}

  private requireTenantId(): string {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    return tenantId
  }

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = this.requireTenantId()
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
    const tenantId = this.requireTenantId()
    const normalized = validateState(state)

    const result = await this.db.query<StatusRow>(
      `
      INSERT INTO audit_chain_verification_status (
        id,
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET
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
        normalized.lastVerifiedHeight,
        normalized.verifiedAt,
        normalized.status,
        normalized.firstBreakSeq,
        normalized.violationCount,
        normalized.rowsChecked,
      ],
    )

    if (!result.rows || result.rows.length === 0) {
      throw new Error('Failed to persist audit chain verification status')
    }

    return mapRow(result.rows[0])
  }

  async clear(): Promise<void> {
    const tenantId = this.requireTenantId()
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
      WHERE id = $1
      `,
      [tenantId],
    )
  }
}

export class InMemoryAuditChainVerificationRepository implements AuditChainVerificationRepository {
  private readonly states = new Map<string, AuditChainVerificationState>()

  private requireTenantId(): string {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    return tenantId
  }

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = this.requireTenantId()
    const state = this.states.get(tenantId)
    return state ? cloneState(state) : null
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = this.requireTenantId()
    const normalized = validateState(state)
    this.states.set(tenantId, cloneState(normalized))
    return cloneState(normalized)
  }

  async clear(): Promise<void> {
    const tenantId = this.requireTenantId()
    this.states.delete(tenantId)
  }
}
