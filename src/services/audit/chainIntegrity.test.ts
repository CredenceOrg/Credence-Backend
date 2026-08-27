import { describe, expect, it } from 'vitest'
import {
  AuditLogService,
  AuditAction,
} from './index.js'
import { InMemoryAuditLogsRepository } from '../../db/repositories/auditLogsRepository.js'
import type { AuditLogEntry } from './types.js'

const input = (resourceId: string, details: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-integrity',
  actorId: 'operator-1',
  actorEmail: 'operator@example.test',
  action: AuditAction.UPDATE_SETTINGS,
  resourceType: 'settings',
  resourceId,
  details,
  requestId: `request-${resourceId}`,
})

async function seeded(repo: InMemoryAuditLogsRepository = new InMemoryAuditLogsRepository()) {
  const service = new AuditLogService(repo)
  await service.logAction(input('one', { setting: 'a' }))
  await service.logAction(input('two', { setting: 'b' }))
  await service.logAction(input('three', { setting: 'c' }))
  return { service, repo }
}

class MutatingRepository extends InMemoryAuditLogsRepository {
  constructor(private readonly mutate: (rows: AuditLogEntry[]) => AuditLogEntry[]) {
    super()
  }

  override async getAll(): Promise<AuditLogEntry[]> {
    const rows = await super.getAll()
    return this.mutate(rows.map((row) => ({ ...row, details: { ...row.details } })))
  }
}

describe('audit chain verification', () => {
  it('accepts a canonical chain and persists a healthy status', async () => {
    const { service } = await seeded()
    const result = await service.verifyChain()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(3)
    expect(result.violationCount).toBe(0)
    expect(result.lastCheckedSeq).toBe(3)
    expect(result.firstViolationSeq).toBeUndefined()
    expect((await service.getChainVerificationStatus())?.status).toBe('valid')
  })

  it.each([
    ['actorId', (row: AuditLogEntry) => { row.actorId = 'attacker' }],
    ['action', (row: AuditLogEntry) => { row.action = 'DELETE_USER' }],
    ['resourceType', (row: AuditLogEntry) => { row.resourceType = 'other' }],
    ['resourceId', (row: AuditLogEntry) => { row.resourceId = 'changed' }],
    ['status', (row: AuditLogEntry) => { row.status = 'failure' }],
    ['tenantId', (row: AuditLogEntry) => { row.tenantId = 'other-tenant' }],
    ['requestId', (row: AuditLogEntry) => { row.requestId = 'changed-request' }],
    ['details', (row: AuditLogEntry) => { row.details = { changed: true } }],
    ['timestamp', (row: AuditLogEntry) => { row.timestamp = new Date(0).toISOString() }],
  ])('detects tampering with the signed %s field', async (_field, mutate) => {
    const repo = new MutatingRepository((rows) => {
      mutate(rows[1])
      return rows
    })
    const { service } = await seeded(repo)
    const result = await service.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstViolationSeq).toBe(2)
    expect(result.violations.some((violation) => violation.type === 'row_hash_mismatch')).toBe(true)
  })

  it('reports deletion at the first missing sequence rather than a boolean only', async () => {
    const repo = new MutatingRepository((rows) => [rows[0], rows[2]])
    const { service } = await seeded(repo)
    const result = await service.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstViolationSeq).toBe(2)
    expect(result.firstViolationId).toBe(rowsId(await repo.getAll(), 2))
    expect(result.violations[0].type).toBe('missing_row')
  })

  it('reports insertion and preserves the original first break', async () => {
    const repo = new MutatingRepository((rows) => [rows[0], {
      ...rows[0],
      id: 'inserted-row',
      seq: 2,
      rowHash: rows[0].rowHash,
      prevHash: rows[0].prevHash,
    }, rows[1], rows[2]])
    const { service } = await seeded(repo)
    const result = await service.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstViolationSeq).toBe(2)
    expect(result.violationCount).toBeGreaterThan(0)
  })

  it('fails closed when a row is malformed or truncated', async () => {
    const repo = new MutatingRepository((rows) => {
      const malformed = { ...rows[1] } as AuditLogEntry
      delete (malformed as Partial<AuditLogEntry>).rowHash
      malformed.details = undefined as unknown as Record<string, unknown>
      return [rows[0], malformed]
    })
    const { service } = await seeded(repo)
    const result = await service.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstViolationSeq).toBe(2)
    expect(result.violationCount).toBeGreaterThan(0)
  })

  it('uses sequence order rather than timestamp order for deterministic verification', async () => {
    const repo = new MutatingRepository((rows) => rows.reverse())
    const { service } = await seeded(repo)
    const result = await service.verifyChain()

    expect(result.valid).toBe(true)
    expect(result.lastCheckedSeq).toBe(3)
  })

  it('handles concurrent appends with one deterministic sequence per entry', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const service = new AuditLogService(repo)
    await Promise.all(Array.from({ length: 20 }, (_, index) => service.logAction(input(`concurrent-${index}`))))
    const rows = await service.getAllLogs()
    const sequences = rows.map((row) => row.seq).sort((a, b) => Number(a) - Number(b))

    expect(new Set(sequences).size).toBe(20)
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect((await service.verifyChain()).valid).toBe(true)
  })

  it('requires explicit operator authorization for repair requests', async () => {
    const { service } = await seeded()
    await expect(service.requestChainRepair('tenant-integrity', {
      operatorId: '', approvedBy: 'security', authorizationRef: 'ticket-1', reason: 'repair',
    })).rejects.toThrow('Explicit repair authorization')
  })

  it('records a non-destructive repair marker and does not rewrite history', async () => {
    const { service } = await seeded()
    const before = await service.getAllLogs()
    const marker = await service.requestChainRepair('tenant-integrity', {
      operatorId: 'operator-2', approvedBy: 'security-lead', authorizationRef: 'INC-123', reason: 'restore export',
    })
    const after = await service.getAllLogs()

    expect(marker.marker.action).toBe(AuditAction.CHAIN_REPAIR_REQUESTED)
    expect(after.slice(0, 3).map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect((await service.verifyChain()).valid).toBe(true)
  })
})

function rowsId(rows: AuditLogEntry[], index: number): string {
  return rows[index - 1]?.id ?? 'missing'
}
