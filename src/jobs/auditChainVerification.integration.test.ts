import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AuditChainVerifier,
  runAuditChainVerification,
  type ReadOnlyAuditDb,
} from './auditChainVerifier.js'
import { AuditLogService } from '../services/audit/index.js'
import { InMemoryAuditLogsRepository, computeRowHash } from '../db/repositories/auditLogsRepository.js'
import { InMemoryAuditChainVerificationRepository } from '../db/repositories/auditChainVerificationRepository.js'
import { logAuditChainVerification } from './auditChainVerificationLog.js'
import { LogEventType } from '../observability/logSchemas.js'
import { redact } from '../observability/redaction.js'
import { AuditAction } from '../services/audit/types.js'

function makeRow(overrides: Partial<{
  id: string
  seq: number
  occurred_at: string
  actor_id: string
  action: string
  resource_type: string
  resource_id: string
  details_json: Record<string, unknown> | null
  status: string
  tenant_id: string
  prev_hash: string | null
  row_hash: string | null
}> = {}) {
  return {
    id: overrides.id ?? 'row-1',
    seq: overrides.seq ?? 1,
    occurred_at: overrides.occurred_at ?? '2025-01-01T00:00:00.000Z',
    actor_id: overrides.actor_id ?? 'actor-1',
    action: overrides.action ?? AuditAction.ASSIGN_ROLE,
    resource_type: overrides.resource_type ?? 'user',
    resource_id: overrides.resource_id ?? 'res-1',
    details_json: overrides.details_json ?? {},
    status: overrides.status ?? 'success',
    tenant_id: overrides.tenant_id ?? 'tenant-1',
    prev_hash: overrides.prev_hash ?? null,
    row_hash: overrides.row_hash ?? null,
  }
}

function computeHash(row: ReturnType<typeof makeRow>, prevHash: string | null = null): string {
  const detailsStr = row.details_json !== null ? JSON.stringify(row.details_json) : '{}'
  return computeRowHash(
    prevHash,
    row.id,
    String(row.occurred_at),
    row.actor_id,
    row.action,
    row.resource_type,
    row.resource_id,
    detailsStr,
    row.status,
    row.tenant_id,
  )
}

function buildValidChain(n: number): ReturnType<typeof makeRow>[] {
  const rows: ReturnType<typeof makeRow>[] = []
  let prevHash: string | null = null

  for (let i = 1; i <= n; i++) {
    const row = makeRow({
      id: `row-${i}`,
      seq: i,
      occurred_at: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      prev_hash: prevHash,
    })
    row.row_hash = computeHash(row, prevHash)
    prevHash = row.row_hash
    rows.push(row)
  }

  return rows
}

function createMockDb(rows: ReturnType<typeof makeRow>[]): ReadOnlyAuditDb {
  return {
    query: vi.fn(async (_sql: string, params?: unknown[]) => {
      const afterSeq = (params?.[0] as number) ?? 0
      const limit = (params?.[1] as number) ?? 1000
      const filtered = rows.filter((r) => r.seq > afterSeq).slice(0, limit)
      return { rows: filtered }
    }),
  }
}

describe('runAuditChainVerification hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists and logs when hooks are provided', async () => {
    const chainStatusRepo = new InMemoryAuditChainVerificationRepository()
    const auditService = new AuditLogService(new InMemoryAuditLogsRepository(), chainStatusRepo)
    const saveStatus = vi.fn(async (result) => auditService.saveChainVerificationStatus(result))
    const logVerification = vi.fn()
    const db = createMockDb([])

    const result = await runAuditChainVerification(
      db,
      undefined,
      {},
      { saveStatus, logVerification },
    )

    expect(result.valid).toBe(true)
    expect(saveStatus).toHaveBeenCalledOnce()
    expect(logVerification).toHaveBeenCalledOnce()

    const status = await auditService.getChainVerificationStatus()
    expect(status?.status).toBe('valid')
    expect(status?.lastVerifiedHeight).toBe(0)
  })

  it('persists break_detected state when verification fails', async () => {
    const chain = buildValidChain(3)
    chain[1].action = 'TAMPERED'

    const chainStatusRepo = new InMemoryAuditChainVerificationRepository()
    const auditService = new AuditLogService(new InMemoryAuditLogsRepository(), chainStatusRepo)
    const db = createMockDb(chain)

    await runAuditChainVerification(db, undefined, {}, {
      saveStatus: (result) => auditService.saveChainVerificationStatus(result),
    })

    const status = await auditService.getChainVerificationStatus()
    expect(status?.status).toBe('break_detected')
    expect(status?.firstBreakSeq).toBe(2)
    expect(status?.lastVerifiedHeight).toBe(1)
  })
})

describe('logAuditChainVerification', () => {
  it('redacts to the audit-chain verification schema', () => {
    const payload = {
      eventType: LogEventType.AUDIT_CHAIN_VERIFICATION,
      valid: false,
      rowsChecked: 3,
      violationCount: 1,
      lastCheckedSeq: 3,
      firstViolationSeq: 2,
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    const redacted = redact(payload, { eventType: LogEventType.AUDIT_CHAIN_VERIFICATION })

    expect(redacted.valid).toBe(false)
    expect(redacted.firstViolationSeq).toBe(2)
    expect(logAuditChainVerification).toBeTypeOf('function')
  })
})

describe('AuditChainVerifier lastCheckedSeq', () => {
  it('includes lastCheckedSeq in the result', async () => {
    const db: ReadOnlyAuditDb = {
      query: vi.fn(async () => ({ rows: [] })),
    }

    const verifier = new AuditChainVerifier(db)
    const result = await verifier.verify()

    expect(result.lastCheckedSeq).toBe(0)
  })
})
