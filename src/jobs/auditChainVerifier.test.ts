import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AuditChainVerifier,
  NoOpAuditChainMetrics,
  ConsoleAuditChainMetrics,
  runAuditChainVerification,
  type ReadOnlyAuditDb,
  type AuditChainMetrics,
} from './auditChainVerifier.js'
import { computeRowHash, InMemoryAuditLogsRepository } from '../db/repositories/auditLogsRepository.js'
import { AuditAction } from '../services/audit/types.js'
import type { ChainVerificationResult } from '../services/audit/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/**
 * Build a valid chain of N rows with correct hashes.
 */
function buildValidChain(n: number): ReturnType<typeof makeRow>[] {
  const rows: ReturnType<typeof makeRow>[] = []
  let prevHash: string | null = null

  for (let i = 1; i <= n; i++) {
    const row = makeRow({
      id: `row-${i}`,
      seq: i,
      occurred_at: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      actor_id: `actor-${i}`,
      action: AuditAction.ASSIGN_ROLE,
      resource_type: 'user',
      resource_id: `res-${i}`,
      details_json: { index: i },
      status: 'success',
      tenant_id: 'tenant-1',
      prev_hash: prevHash,
    })

    row.row_hash = computeHash(row, prevHash)
    prevHash = row.row_hash
    rows.push(row)
  }

  return rows
}

/**
 * Create a mock DB that returns rows in sequence-ordered batches.
 */
function createMockDb(rows: ReturnType<typeof makeRow>[]): ReadOnlyAuditDb {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const afterSeq = (params?.[0] as number) ?? 0
      const limit = (params?.[1] as number) ?? 1000
      const filtered = rows.filter((r) => r.seq > afterSeq).slice(0, limit)
      return { rows: filtered }
    }),
  }
}

/**
 * Create a spy metrics object.
 */
function createSpyMetrics(): AuditChainMetrics & {
  violations: number
  rowsCheckedVal: number
  lastValid: boolean | null
} {
  const spy = {
    violations: 0,
    rowsCheckedVal: 0,
    lastValid: null as boolean | null,
    lastTimestamp: 0,
    incViolation(count = 1) { spy.violations += count },
    setRowsChecked(count: number) { spy.rowsCheckedVal = count },
    setLastRunTimestamp(ts: number) { spy.lastTimestamp = ts },
    setLastRunValid(valid: boolean) { spy.lastValid = valid },
  }
  return spy
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('computeRowHash', () => {
  it('produces a 64-char hex SHA-256 string', () => {
    const hash = computeRowHash(
      null,
      'test-id',
      '2025-01-01T00:00:00.000Z',
      'actor-1',
      'ASSIGN_ROLE',
      'user',
      'res-1',
      '{}',
      'success',
      'tenant-1',
    )
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('uses GENESIS for null prev_hash', () => {
    const hash1 = computeRowHash(null, 'id', 'ts', 'a', 'act', 'rt', 'ri', '{}', 's', 't')
    const hash2 = computeRowHash('some-hash', 'id', 'ts', 'a', 'act', 'rt', 'ri', '{}', 's', 't')
    expect(hash1).not.toBe(hash2)
  })

  it('is deterministic', () => {
    const args = [null, 'id', 'ts', 'a', 'act', 'rt', 'ri', '{}', 's', 't'] as const
    expect(computeRowHash(...args)).toBe(computeRowHash(...args))
  })

  it('changes if any field changes', () => {
    const base = [null, 'id', 'ts', 'a', 'act', 'rt', 'ri', '{}', 's', 't'] as const
    const baseHash = computeRowHash(...base)

    // Change actor_id
    expect(computeRowHash(null, 'id', 'ts', 'DIFFERENT', 'act', 'rt', 'ri', '{}', 's', 't')).not.toBe(baseHash)
    // Change action
    expect(computeRowHash(null, 'id', 'ts', 'a', 'DIFFERENT', 'rt', 'ri', '{}', 's', 't')).not.toBe(baseHash)
    // Change details
    expect(computeRowHash(null, 'id', 'ts', 'a', 'act', 'rt', 'ri', '{"x":1}', 's', 't')).not.toBe(baseHash)
    // Change tenant_id
    expect(computeRowHash(null, 'id', 'ts', 'a', 'act', 'rt', 'ri', '{}', 's', 'different')).not.toBe(baseHash)
  })
})

describe('AuditChainVerifier', () => {
  describe('valid chain', () => {
    it('verifies an empty table', async () => {
      const db = createMockDb([])
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(0)
      expect(result.violationCount).toBe(0)
      expect(result.violations).toEqual([])
      expect(metrics.lastValid).toBe(true)
      expect(metrics.rowsCheckedVal).toBe(0)
    })

    it('verifies a single genesis row', async () => {
      const chain = buildValidChain(1)
      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(1)
      expect(result.violationCount).toBe(0)
      expect(metrics.lastValid).toBe(true)
    })

    it('verifies a valid chain of 10 rows', async () => {
      const chain = buildValidChain(10)
      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(10)
      expect(result.violationCount).toBe(0)
      expect(metrics.lastValid).toBe(true)
      expect(metrics.rowsCheckedVal).toBe(10)
    })

    it('verifies a valid chain with batching', async () => {
      const chain = buildValidChain(25)
      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics, { batchSize: 10 })

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(25)
      // 25 rows / 10 batch = 3 batches (10, 10, 5). Last batch < batchSize stops loop.
      expect(db.query).toHaveBeenCalledTimes(3)
    })
  })

  describe('tampered chain — row mutation', () => {
    it('detects row_hash mismatch when a row is mutated', async () => {
      const chain = buildValidChain(5)
      // Tamper with row 3's action (simulating someone updating the DB directly)
      chain[2].action = 'TAMPERED_ACTION'
      // The row_hash is now stale (still the old hash)

      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      expect(result.violationCount).toBeGreaterThanOrEqual(1)
      expect(result.firstViolationSeq).toBe(3)
      expect(result.firstViolationId).toBe('row-3')
      expect(metrics.lastValid).toBe(false)
      expect(metrics.violations).toBeGreaterThanOrEqual(1)

      const hashViolation = result.violations.find((v) => v.type === 'row_hash_mismatch' && v.seq === 3)
      expect(hashViolation).toBeDefined()
    })

    it('detects row_hash mismatch when details_json is tampered', async () => {
      const chain = buildValidChain(3)
      chain[1].details_json = { tampered: true }

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      expect(result.violations.some((v) => v.type === 'row_hash_mismatch' && v.seq === 2)).toBe(true)
    })

    it('detects row_hash mismatch when status is tampered', async () => {
      const chain = buildValidChain(3)
      chain[1].status = 'failure'

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      expect(result.violations.some((v) => v.type === 'row_hash_mismatch' && v.seq === 2)).toBe(true)
    })
  })

  describe('tampered chain — prev_hash mismatch', () => {
    it('detects prev_hash mismatch when prev_hash is overwritten', async () => {
      const chain = buildValidChain(5)
      // Overwrite row 4's prev_hash with garbage
      chain[3].prev_hash = 'aaaa_fake_hash'

      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      const prevViolation = result.violations.find((v) => v.type === 'prev_hash_mismatch')
      expect(prevViolation).toBeDefined()
      expect(prevViolation!.seq).toBe(4)
    })
  })

  describe('tampered chain — deleted rows', () => {
    it('detects a gap in sequence numbers (row deletion)', async () => {
      const chain = buildValidChain(5)
      // Remove row 3 (seq=3), simulating a DELETE
      const withDeletion = chain.filter((r) => r.seq !== 3)

      const db = createMockDb(withDeletion)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)

      const deletionViolation = result.violations.find((v) => v.type === 'deleted_row')
      expect(deletionViolation).toBeDefined()
      expect(deletionViolation!.seq).toBe(4) // seq 4 notices the gap after seq 2
    })

    it('detects multiple deleted rows', async () => {
      const chain = buildValidChain(10)
      // Remove rows 3 and 7
      const withDeletions = chain.filter((r) => r.seq !== 3 && r.seq !== 7)

      const db = createMockDb(withDeletions)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      const deletionViolations = result.violations.filter((v) => v.type === 'deleted_row')
      expect(deletionViolations.length).toBeGreaterThanOrEqual(2)
    })

    it('detects deletion of the genesis row', async () => {
      const chain = buildValidChain(5)
      // Remove the genesis row (seq=1)
      const withoutGenesis = chain.filter((r) => r.seq !== 1)

      const db = createMockDb(withoutGenesis)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      // Row 2 has a prev_hash that doesn't match null (since there's no predecessor)
      // and/or the prev_hash won't match the expected (which is null for the first row seen)
      expect(result.violationCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe('edge cases', () => {
    it('handles rows with null details_json', async () => {
      const chain = buildValidChain(1)
      chain[0].details_json = null
      // Recompute hash with null details
      chain[0].row_hash = computeHash(chain[0], null)

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
    })

    it('handles rows with Date objects for occurred_at', async () => {
      const chain = buildValidChain(1)
      // Simulate DB returning a Date object
      chain[0].occurred_at = new Date('2025-01-01T00:00:01.000Z') as any
      // Recompute hash with the ISO string representation
      chain[0].row_hash = computeHash({
        ...chain[0],
        occurred_at: new Date('2025-01-01T00:00:01.000Z').toISOString(),
      }, null)

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
    })

    it('respects maxViolations limit', async () => {
      // Create a chain where every row after the first has a bad prev_hash
      const chain = buildValidChain(50)
      for (let i = 1; i < chain.length; i++) {
        chain[i].prev_hash = 'bad-hash-' + i
      }

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { maxViolations: 5 })

      const result = await verifier.verify()

      expect(result.valid).toBe(false)
      expect(result.violations.length).toBeLessThanOrEqual(5)
    })

    it('handles clock skew — rows with same timestamp but different seqs', async () => {
      const chain = buildValidChain(3)
      // Give all rows the same timestamp (simulating clock skew)
      const sameTime = '2025-01-01T00:00:00.000Z'
      let prevHash: string | null = null

      for (const row of chain) {
        row.occurred_at = sameTime
        row.prev_hash = prevHash
        row.row_hash = computeHash(row, prevHash)
        prevHash = row.row_hash
      }

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(3)
    })

    it('handles parallel inserts in the same millisecond', async () => {
      // This is the same as clock skew — seq ensures ordering
      const chain = buildValidChain(5)
      const sameTime = '2025-06-01T12:00:00.000Z'
      let prevHash: string | null = null

      for (const row of chain) {
        row.occurred_at = sameTime
        row.prev_hash = prevHash
        row.row_hash = computeHash(row, prevHash)
        prevHash = row.row_hash
      }

      const db = createMockDb(chain)
      const verifier = new AuditChainVerifier(db)

      const result = await verifier.verify()

      expect(result.valid).toBe(true)
    })
  })

  describe('metrics emission', () => {
    it('emits correct metrics for a valid chain', async () => {
      const chain = buildValidChain(5)
      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      await verifier.verify()

      expect(metrics.rowsCheckedVal).toBe(5)
      expect(metrics.lastValid).toBe(true)
      expect(metrics.violations).toBe(0)
    })

    it('emits correct metrics for a tampered chain', async () => {
      const chain = buildValidChain(5)
      chain[2].action = 'TAMPERED'

      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      await verifier.verify()

      expect(metrics.lastValid).toBe(false)
      expect(metrics.violations).toBeGreaterThan(0)
    })

    it('increments violation count cumulatively', async () => {
      const chain = buildValidChain(3)
      chain[1].action = 'TAMPERED1'
      chain[2].action = 'TAMPERED2'

      const db = createMockDb(chain)
      const metrics = createSpyMetrics()
      const verifier = new AuditChainVerifier(db, metrics)

      await verifier.verify()

      // Multiple violations should all be counted
      expect(metrics.violations).toBeGreaterThanOrEqual(2)
    })
  })

  describe('logger', () => {
    it('logs verification start and completion', async () => {
      const chain = buildValidChain(3)
      const db = createMockDb(chain)
      const logs: string[] = []
      const logger = (msg: string) => logs.push(msg)
      const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { logger })

      await verifier.verify()

      expect(logs.some((l) => l.includes('Starting'))).toBe(true)
      expect(logs.some((l) => l.includes('Chain OK'))).toBe(true)
    })

    it('logs violations', async () => {
      const chain = buildValidChain(3)
      chain[1].action = 'TAMPERED'

      const db = createMockDb(chain)
      const logs: string[] = []
      const logger = (msg: string) => logs.push(msg)
      const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { logger })

      await verifier.verify()

      expect(logs.some((l) => l.includes('INTEGRITY VIOLATION'))).toBe(true)
    })
  })

  describe('DB error handling', () => {
    it('propagates database errors', async () => {
      const db: ReadOnlyAuditDb = {
        query: vi.fn().mockRejectedValue(new Error('connection refused')),
      }
      const verifier = new AuditChainVerifier(db)

      await expect(verifier.verify()).rejects.toThrow('connection refused')
    })
  })
})

describe('NoOpAuditChainMetrics', () => {
  it('does not throw on any method call', () => {
    const metrics = new NoOpAuditChainMetrics()
    expect(() => metrics.incViolation()).not.toThrow()
    expect(() => metrics.incViolation(5)).not.toThrow()
    expect(() => metrics.setRowsChecked(100)).not.toThrow()
    expect(() => metrics.setLastRunTimestamp(Date.now())).not.toThrow()
    expect(() => metrics.setLastRunValid(true)).not.toThrow()
    expect(() => metrics.setLastRunValid(false)).not.toThrow()
  })
})

describe('ConsoleAuditChainMetrics', () => {
  it('tracks violation count', () => {
    const metrics = new ConsoleAuditChainMetrics()
    metrics.incViolation(3)
    expect(metrics.violationCount).toBe(3)
    metrics.incViolation(2)
    expect(metrics.violationCount).toBe(5)
  })

  it('tracks rows checked', () => {
    const metrics = new ConsoleAuditChainMetrics()
    metrics.setRowsChecked(42)
    expect(metrics.rowsChecked).toBe(42)
  })

  it('tracks last run validity', () => {
    const metrics = new ConsoleAuditChainMetrics()
    metrics.setLastRunValid(true)
    expect(metrics.lastRunValid).toBe(true)
    metrics.setLastRunValid(false)
    expect(metrics.lastRunValid).toBe(false)
  })

  it('tracks last run timestamp', () => {
    const metrics = new ConsoleAuditChainMetrics()
    const ts = Date.now()
    metrics.setLastRunTimestamp(ts)
    expect(metrics.lastRunTimestamp).toBe(ts)
  })

  it('logs to console.error on violation', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const metrics = new ConsoleAuditChainMetrics()
    metrics.incViolation()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('VIOLATION'))
    spy.mockRestore()
  })

  it('logs to console.error on invalid run', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const metrics = new ConsoleAuditChainMetrics()
    metrics.setLastRunValid(false)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('FAILED'))
    spy.mockRestore()
  })
})

describe('runAuditChainVerification', () => {
  it('creates verifier and runs verification', async () => {
    const chain = buildValidChain(3)
    const db = createMockDb(chain)
    const metrics = createSpyMetrics()

    const result = await runAuditChainVerification(db, metrics)

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(3)
  })

  it('works with default metrics', async () => {
    const db = createMockDb([])
    const result = await runAuditChainVerification(db)
    expect(result.valid).toBe(true)
  })
})

describe('InMemoryAuditLogsRepository hash chain', () => {
  let repository: InMemoryAuditLogsRepository

  beforeEach(() => {
    repository = new InMemoryAuditLogsRepository()
  })

  it('first entry has null prevHash and a valid rowHash', async () => {
    const entry = await repository.append({
      actorId: 'actor-1',
      actorEmail: 'actor@test.com',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'res-1',
      details: { role: 'admin' },
      tenantId: 'tenant-1',
    })

    expect(entry.prevHash).toBeNull()
    expect(entry.rowHash).toMatch(/^[a-f0-9]{64}$/)
    expect(entry.seq).toBe(1)
  })

  it('second entry has prevHash equal to first entry rowHash', async () => {
    const first = await repository.append({
      actorId: 'actor-1',
      actorEmail: 'actor@test.com',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'res-1',
      tenantId: 'tenant-1',
    })

    const second = await repository.append({
      actorId: 'actor-2',
      actorEmail: 'actor2@test.com',
      action: AuditAction.REVOKE_ROLE,
      resourceType: 'user',
      resourceId: 'res-2',
      tenantId: 'tenant-1',
    })

    expect(second.prevHash).toBe(first.rowHash)
    expect(second.rowHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.rowHash).not.toBe(first.rowHash)
    expect(second.seq).toBe(2)
  })

  it('chain of 5 entries is self-consistent', async () => {
    const entries: any[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(
        await repository.append({
          actorId: `actor-${i}`,
          actorEmail: `actor${i}@test.com`,
          action: AuditAction.ASSIGN_ROLE,
          resourceType: 'user',
          resourceId: `res-${i}`,
          details: { index: i },
          tenantId: 'tenant-1',
        }),
      )
    }

    // Verify chain linkage
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].prevHash).toBe(entries[i - 1].rowHash)
    }
    expect(entries[0].prevHash).toBeNull()
  })

  it('clear resets the chain', async () => {
    await repository.append({
      actorId: 'actor-1',
      actorEmail: 'a@test.com',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'res-1',
      tenantId: 'tenant-1',
    })

    await repository.clear()

    const newEntry = await repository.append({
      actorId: 'actor-2',
      actorEmail: 'b@test.com',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'res-2',
      tenantId: 'tenant-1',
    })

    expect(newEntry.prevHash).toBeNull()
    expect(newEntry.seq).toBe(1)
  })

  it('in-memory chain verifies correctly with AuditChainVerifier', async () => {
    const entries: any[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(
        await repository.append({
          actorId: `actor-${i}`,
          actorEmail: `actor${i}@test.com`,
          action: AuditAction.ASSIGN_ROLE,
          resourceType: 'user',
          resourceId: `res-${i}`,
          details: { idx: i },
          tenantId: 'tenant-1',
        }),
      )
    }

    // Build rows in the format the verifier expects
    const rows = entries.map((e: any) => ({
      id: e.id,
      seq: e.seq,
      occurred_at: e.timestamp,
      actor_id: e.actorId,
      action: e.action as string,
      resource_type: e.resourceType,
      resource_id: e.resourceId,
      details_json: e.details,
      status: e.status,
      tenant_id: e.tenantId,
      prev_hash: e.prevHash,
      row_hash: e.rowHash,
    }))

    const db = createMockDb(rows as any)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()
    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(5)
  })
})

describe('ChainVerificationResult', () => {
  it('has correct shape for valid result', async () => {
    const chain = buildValidChain(3)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result).toHaveProperty('valid', true)
    expect(result).toHaveProperty('rowsChecked', 3)
    expect(result).toHaveProperty('violationCount', 0)
    expect(result).toHaveProperty('violations')
    expect(result).toHaveProperty('checkedAt')
    expect(result.firstViolationSeq).toBeUndefined()
    expect(result.firstViolationId).toBeUndefined()
    expect(new Date(result.checkedAt).getTime()).not.toBeNaN()
  })

  it('has correct shape for invalid result', async () => {
    const chain = buildValidChain(3)
    chain[1].action = 'TAMPERED'
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result).toHaveProperty('valid', false)
    expect(result.violationCount).toBeGreaterThan(0)
    expect(result.firstViolationSeq).toBeDefined()
    expect(result.firstViolationId).toBeDefined()
    expect(result.violations.length).toBe(result.violationCount)
  })
})
