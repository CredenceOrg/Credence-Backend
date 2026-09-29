/**
 * Boundary and recovery test coverage for AuditChainVerifier.
 *
 * These tests target edge cases that the main unit test file does not cover:
 *
 *  - Exact batchSize boundaries (full last batch forces one extra empty query)
 *  - maxViolations=1 stops after the very first violation
 *  - batchSize=1 correct row-by-row traversal
 *  - DB error on the second batch (partial failure / recovery invariants)
 *  - saveStatus hook error propagation via runAuditChainVerification
 *  - logVerification hook error propagation
 *  - Concurrent independent verifier runs don't share state
 *  - lastCheckedSeq tracks the last row processed before maxViolations cutoff
 *  - Violations from multiple types in a single run (deleted_row + row_hash_mismatch)
 *  - All rows tampered — capped at maxViolations, metrics still emitted
 *  - Chain where only the last row is tampered
 *  - Verifier is stateless — calling verify() twice returns consistent independent results
 *  - Rows with empty-string actor/resource fields (boundary for hash computation)
 *  - Very large seq numbers (no integer overflow / incorrect gap detection)
 *  - prev_hash of genesis row is null (not undefined)
 *  - checkedAt is always a valid ISO 8601 timestamp
 *  - setLastRunTimestamp is called with a reasonable epoch value
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AuditChainVerifier,
  NoOpAuditChainMetrics,
  runAuditChainVerification,
  type ReadOnlyAuditDb,
  type AuditChainMetrics,
} from './auditChainVerifier.js'
import { computeRowHash } from '../db/repositories/auditLogsRepository.js'
import { AuditAction } from '../services/audit/types.js'

// ─── Shared helpers (duplicated locally so this file is fully self-contained) ─

type ChainRow = {
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
}

function makeRow(overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    id: overrides.id ?? 'row-1',
    seq: overrides.seq ?? 1,
    occurred_at: overrides.occurred_at ?? '2025-01-01T00:00:00.000Z',
    actor_id: overrides.actor_id ?? 'actor-1',
    action: overrides.action ?? AuditAction.ASSIGN_ROLE,
    resource_type: overrides.resource_type ?? 'user',
    resource_id: overrides.resource_id ?? 'res-1',
    details_json: overrides.details_json !== undefined ? overrides.details_json : {},
    status: overrides.status ?? 'success',
    tenant_id: overrides.tenant_id ?? 'tenant-1',
    prev_hash: overrides.prev_hash !== undefined ? overrides.prev_hash : null,
    row_hash: overrides.row_hash !== undefined ? overrides.row_hash : null,
  }
}

function computeHash(row: ChainRow, prevHash: string | null = null): string {
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

function buildValidChain(n: number, seqStart = 1): ChainRow[] {
  const rows: ChainRow[] = []
  let prevHash: string | null = null

  for (let i = 0; i < n; i++) {
    const seq = seqStart + i
    const row = makeRow({
      id: `row-${seq}`,
      seq,
      occurred_at: new Date(Date.UTC(2025, 0, 1, 0, 0, seq)).toISOString(),
      actor_id: `actor-${seq}`,
      action: AuditAction.ASSIGN_ROLE,
      resource_type: 'user',
      resource_id: `res-${seq}`,
      details_json: { index: seq },
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

function createMockDb(rows: ChainRow[]): ReadOnlyAuditDb & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async (_sql: string, params?: unknown[]) => {
      const afterSeq = (params?.[0] as number) ?? 0
      const limit = (params?.[1] as number) ?? 1000
      const filtered = rows.filter((r) => r.seq > afterSeq).slice(0, limit)
      return { rows: filtered }
    }),
  }
}

function createSpyMetrics(): AuditChainMetrics & {
  violations: number
  rowsCheckedVal: number
  lastValid: boolean | null
  lastTimestamp: number
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

describe('AuditChainVerifier — batch boundary', () => {
  it('issues one extra empty-page query when rows count equals batchSize exactly', async () => {
    // Exactly 10 rows with batchSize=10: the verifier sees a full batch, so it
    // tries another page, gets zero rows, and then stops.
    const chain = buildValidChain(10)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { batchSize: 10 })

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(10)
    // First call: rows 1-10; second call: empty page
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('does NOT issue an extra query when rows count is less than batchSize', async () => {
    // 9 rows with batchSize=10: partial batch → loop stops without an extra trip.
    const chain = buildValidChain(9)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { batchSize: 10 })

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(9)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('handles rows count that is a multiple of batchSize across several pages', async () => {
    // 30 rows, batchSize=10 → 3 full pages + 1 empty terminator = 4 queries
    const chain = buildValidChain(30)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { batchSize: 10 })

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(30)
    expect(db.query).toHaveBeenCalledTimes(4)
  })
})

describe('AuditChainVerifier — batchSize=1', () => {
  it('verifies a valid chain one row at a time', async () => {
    const chain = buildValidChain(5)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { batchSize: 1 })

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(5)
    // 5 full batches + 1 empty terminator = 6 queries
    expect(db.query).toHaveBeenCalledTimes(6)
  })

  it('detects a tampered row with batchSize=1', async () => {
    const chain = buildValidChain(5)
    // Tamper row 3 (index 2)
    chain[2].action = 'TAMPERED'

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { batchSize: 1 })

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.type === 'row_hash_mismatch' && v.seq === 3)).toBe(true)
  })
})

describe('AuditChainVerifier — maxViolations boundary', () => {
  it('stops collecting violations at maxViolations=1', async () => {
    // Every row after the first has its action tampered
    const chain = buildValidChain(10)
    for (let i = 1; i < chain.length; i++) {
      chain[i].action = `TAMPERED-${i}`
    }

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { maxViolations: 1 })

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    // Once maxViolations is hit the outer while-loop guard fires, so we stop early
  })

  it('maxViolations=1 — lastCheckedSeq is the seq just before the violation stopped processing', async () => {
    // Chain: rows 1 (valid), 2 (tampered action → row_hash_mismatch, stops there)
    const chain = buildValidChain(5)
    chain[1].action = 'TAMPERED'

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), { maxViolations: 1 })

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    // prevSeq/lastSeq only advance on a passing row; row-2 triggers the break
    // so lastSeq stays at 1
    expect(result.lastCheckedSeq).toBe(1)
  })

  it('outer while-loop exits immediately on second batch if maxViolations already reached at end of first batch', async () => {
    // 3 rows, batchSize=3 (full batch). Row 1 passes, rows 2 and 3 are tampered.
    // After the inner for-loop finishes the first batch, violations.length===2 (>=1),
    // so the outer while condition fires before fetching page 2.
    const chain = buildValidChain(6)
    chain[1].action = 'TAMPERED-2'
    chain[2].action = 'TAMPERED-3'

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), {
      batchSize: 3,
      maxViolations: 1,
    })

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    // Second DB page should NOT be fetched because maxViolations was already hit
    // after the first full batch
    const callCount = (db.query as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callCount).toBe(1)
  })
})

describe('AuditChainVerifier — DB failure recovery', () => {
  it('propagates an error thrown on the very first query', async () => {
    const db: ReadOnlyAuditDb = {
      query: vi.fn().mockRejectedValue(new Error('DB unreachable')),
    }
    const metrics = createSpyMetrics()
    const verifier = new AuditChainVerifier(db, metrics)

    await expect(verifier.verify()).rejects.toThrow('DB unreachable')
    // Metrics should NOT be emitted because we threw before reaching the emit block
    expect(metrics.rowsCheckedVal).toBe(0)
    expect(metrics.lastValid).toBeNull()
  })

  it('propagates an error thrown on the second batch after a successful first batch', async () => {
    const chain = buildValidChain(3)
    let callCount = 0
    const db: ReadOnlyAuditDb = {
      query: vi.fn(async (_sql: string, params?: unknown[]) => {
        callCount++
        if (callCount === 1) {
          // Return rows for the first (full) batch
          const afterSeq = (params?.[0] as number) ?? 0
          const filtered = chain.filter((r) => r.seq > afterSeq).slice(0, 3)
          return { rows: filtered }
        }
        // Second call fails (simulates a transient DB error mid-job)
        throw new Error('transient connection error')
      }),
    }
    const metrics = createSpyMetrics()
    // batchSize=3 so first batch is full → second page is attempted
    const verifier = new AuditChainVerifier(db, metrics, { batchSize: 3 })

    // The error must propagate — we do NOT silently swallow mid-run DB errors
    await expect(verifier.verify()).rejects.toThrow('transient connection error')
    // Metrics not emitted (error path exits before them)
    expect(metrics.lastValid).toBeNull()
  })

  it('logs the error message before re-throwing', async () => {
    const db: ReadOnlyAuditDb = {
      query: vi.fn().mockRejectedValue(new Error('bad gateway')),
    }
    const logs: string[] = []
    const verifier = new AuditChainVerifier(db, new NoOpAuditChainMetrics(), {
      logger: (msg) => logs.push(msg),
    })

    await expect(verifier.verify()).rejects.toThrow()
    expect(logs.some((l) => l.includes('Error during verification'))).toBe(true)
    expect(logs.some((l) => l.includes('bad gateway'))).toBe(true)
  })
})

describe('AuditChainVerifier — state isolation between runs', () => {
  it('two sequential verify() calls on the same instance return independent results', async () => {
    const chain = buildValidChain(3)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result1 = await verifier.verify()
    const result2 = await verifier.verify()

    // Each run should independently traverse the full chain
    expect(result1.valid).toBe(true)
    expect(result2.valid).toBe(true)
    expect(result1.rowsChecked).toBe(3)
    expect(result2.rowsChecked).toBe(3)
    // Both timestamps are valid ISO strings (they may coincide within the same ms)
    expect(new Date(result1.checkedAt).getTime()).toBeGreaterThan(0)
    expect(new Date(result2.checkedAt).getTime()).toBeGreaterThan(0)
    expect(result2.violations).toEqual([])
  })

  it('two concurrent verify() calls on separate instances do not share state', async () => {
    const chain = buildValidChain(5)

    const db1 = createMockDb(chain)
    const db2 = createMockDb(chain)
    const verifier1 = new AuditChainVerifier(db1)
    const verifier2 = new AuditChainVerifier(db2)

    const [result1, result2] = await Promise.all([verifier1.verify(), verifier2.verify()])

    expect(result1.valid).toBe(true)
    expect(result2.valid).toBe(true)
    expect(result1.rowsChecked).toBe(5)
    expect(result2.rowsChecked).toBe(5)
  })
})

describe('AuditChainVerifier — mixed violation types in a single run', () => {
  it('reports both deleted_row and row_hash_mismatch violations', async () => {
    // Chain: 1,2,4,5 (seq 3 deleted → deleted_row on seq 4)
    // AND chain[3] (seq=5) has tampered action → row_hash_mismatch
    const chain = buildValidChain(5)
    const withGap = chain.filter((r) => r.seq !== 3)
    withGap[withGap.length - 1].action = 'TAMPERED'

    const db = createMockDb(withGap)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.type === 'deleted_row')).toBe(true)
    expect(result.violations.some((v) => v.type === 'row_hash_mismatch')).toBe(true)
  })
})

describe('AuditChainVerifier — all rows tampered', () => {
  it('caps at maxViolations even when every row is invalid', async () => {
    const chain = buildValidChain(20)
    // Corrupt every row's action so row_hash will never match
    for (const row of chain) {
      row.action = 'ALL_TAMPERED'
    }

    const db = createMockDb(chain)
    const metrics = createSpyMetrics()
    const verifier = new AuditChainVerifier(db, metrics, { maxViolations: 5 })

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBeLessThanOrEqual(5)
    // Metrics must still be emitted even when we stop early
    expect(metrics.lastValid).toBe(false)
    expect(metrics.violations).toBeGreaterThan(0)
    expect(metrics.rowsCheckedVal).toBeGreaterThan(0)
  })
})

describe('AuditChainVerifier — only the last row is tampered', () => {
  it('reports exactly one violation for the final row', async () => {
    const chain = buildValidChain(5)
    // Tamper only the last row's details
    chain[chain.length - 1].details_json = { injected: true }

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    expect(result.violations[0].type).toBe('row_hash_mismatch')
    expect(result.violations[0].seq).toBe(5)
    expect(result.firstViolationSeq).toBe(5)
    expect(result.firstViolationId).toBe('row-5')
    // lastSeq advances unconditionally after all checks (the break only fires
    // when violations.length >= maxViolations, which is 100 by default).
    expect(result.lastCheckedSeq).toBe(5)
  })
})

describe('AuditChainVerifier — hash computation boundaries', () => {
  it('handles rows with empty-string actor_id and resource_id without crashing', async () => {
    // Build a single row with empty-string fields and valid hashes
    const row = makeRow({
      id: 'edge-1',
      seq: 1,
      occurred_at: '2025-01-01T00:00:00.000Z',
      actor_id: '',
      action: AuditAction.ASSIGN_ROLE,
      resource_type: '',
      resource_id: '',
      details_json: {},
      status: 'success',
      tenant_id: '',
      prev_hash: null,
    })
    row.row_hash = computeHash(row, null)

    const db = createMockDb([row])
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(1)
  })

  it('handles very large seq numbers without integer overflow or false gap detection', async () => {
    // Two consecutive rows with seq values near Number.MAX_SAFE_INTEGER
    const BIG = Number.MAX_SAFE_INTEGER - 1
    const row1 = makeRow({ id: 'big-1', seq: BIG, prev_hash: null })
    row1.row_hash = computeHash(row1, null)

    const row2 = makeRow({
      id: 'big-2',
      seq: BIG + 1,
      prev_hash: row1.row_hash,
    })
    row2.row_hash = computeHash(row2, row1.row_hash)

    const db = createMockDb([row1, row2])
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(2)
    expect(result.lastCheckedSeq).toBe(BIG + 1)
  })

  it('detects a gap between two large-seq consecutive rows', async () => {
    const BIG = 1_000_000
    const row1 = makeRow({ id: 'gap-1', seq: BIG, prev_hash: null })
    row1.row_hash = computeHash(row1, null)

    // seq jumps by 2 → one deleted row
    const row2 = makeRow({
      id: 'gap-2',
      seq: BIG + 2,
      prev_hash: row1.row_hash,
    })
    row2.row_hash = computeHash(row2, row1.row_hash)

    const db = createMockDb([row1, row2])
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.type === 'deleted_row')).toBe(true)
  })
})

describe('AuditChainVerifier — result invariants', () => {
  it('checkedAt is always a valid ISO 8601 timestamp', async () => {
    const db = createMockDb([])
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(() => new Date(result.checkedAt)).not.toThrow()
    expect(new Date(result.checkedAt).getTime()).toBeGreaterThan(0)
    // ISO format check
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('setLastRunTimestamp receives a Unix epoch in milliseconds (not seconds)', async () => {
    const chain = buildValidChain(1)
    const db = createMockDb(chain)
    const metrics = createSpyMetrics()
    const verifier = new AuditChainVerifier(db, metrics)

    const before = Date.now()
    await verifier.verify()
    const after = Date.now()

    // Timestamp must be within the current run window and in milliseconds (≥ year 2000 in ms)
    expect(metrics.lastTimestamp).toBeGreaterThanOrEqual(before)
    expect(metrics.lastTimestamp).toBeLessThanOrEqual(after)
    // Sanity check: milliseconds since epoch for the year 2000 is ~9.5×10^11
    expect(metrics.lastTimestamp).toBeGreaterThan(9.5e11)
  })

  it('violations array length always equals violationCount', async () => {
    const chain = buildValidChain(5)
    chain[1].action = 'TAMPERED1'
    chain[3].action = 'TAMPERED2'

    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.violations.length).toBe(result.violationCount)
  })

  it('firstViolationSeq and firstViolationId are undefined on a valid run', async () => {
    const chain = buildValidChain(3)
    const db = createMockDb(chain)
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    expect(result.firstViolationSeq).toBeUndefined()
    expect(result.firstViolationId).toBeUndefined()
  })

  it('genesis row must have null prev_hash in the stored row to pass', async () => {
    // A genesis row with prev_hash !== null is a chain break
    const row = makeRow({ seq: 1, prev_hash: 'not-null' })
    row.row_hash = computeHash(row, 'not-null')

    const db = createMockDb([row])
    const verifier = new AuditChainVerifier(db)

    const result = await verifier.verify()

    // Verifier starts with prevRowHash=null. Row 1 presents prev_hash='not-null',
    // which triggers a prev_hash_mismatch.
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.type === 'prev_hash_mismatch' && v.seq === 1)).toBe(true)
  })
})

describe('runAuditChainVerification — hook error propagation', () => {
  it('propagates an error thrown by saveStatus', async () => {
    const chain = buildValidChain(2)
    const db = createMockDb(chain)

    const saveError = new Error('persistence failure')
    const hooks = {
      saveStatus: vi.fn().mockRejectedValue(saveError),
      logVerification: vi.fn(),
    }

    await expect(
      runAuditChainVerification(db, new NoOpAuditChainMetrics(), {}, hooks),
    ).rejects.toThrow('persistence failure')

    // saveStatus was called, logVerification was NOT called (error thrown first)
    expect(hooks.saveStatus).toHaveBeenCalledOnce()
    expect(hooks.logVerification).not.toHaveBeenCalled()
  })

  it('propagates an error thrown by logVerification', async () => {
    const chain = buildValidChain(2)
    const db = createMockDb(chain)

    const logError = new Error('log failure')
    const hooks = {
      saveStatus: vi.fn().mockResolvedValue(undefined),
      logVerification: vi.fn().mockImplementation(() => { throw logError }),
    }

    await expect(
      runAuditChainVerification(db, new NoOpAuditChainMetrics(), {}, hooks),
    ).rejects.toThrow('log failure')

    expect(hooks.saveStatus).toHaveBeenCalledOnce()
    expect(hooks.logVerification).toHaveBeenCalledOnce()
  })

  it('succeeds when no hooks are provided', async () => {
    const db = createMockDb([])
    // Must not throw when hooks object is completely empty
    const result = await runAuditChainVerification(db, new NoOpAuditChainMetrics(), {}, {})
    expect(result.valid).toBe(true)
  })

  it('saveStatus receives the correct ChainVerificationResult structure', async () => {
    const chain = buildValidChain(3)
    const db = createMockDb(chain)

    const captured: unknown[] = []
    const hooks = {
      saveStatus: vi.fn(async (r: unknown) => { captured.push(r) }),
    }

    await runAuditChainVerification(db, new NoOpAuditChainMetrics(), {}, hooks)

    expect(captured).toHaveLength(1)
    const result = captured[0] as Record<string, unknown>
    expect(result.valid).toBe(true)
    expect(result.rowsChecked).toBe(3)
    expect(result.violationCount).toBe(0)
    expect(result.violations).toEqual([])
    expect(typeof result.checkedAt).toBe('string')
  })

  it('logVerification receives the correct result when chain is broken', async () => {
    const chain = buildValidChain(3)
    chain[1].action = 'TAMPERED'
    const db = createMockDb(chain)

    const logged: unknown[] = []
    const hooks = {
      logVerification: vi.fn((r: unknown) => { logged.push(r) }),
    }

    await runAuditChainVerification(db, new NoOpAuditChainMetrics(), {}, hooks)

    expect(logged).toHaveLength(1)
    const result = logged[0] as Record<string, unknown>
    expect(result.valid).toBe(false)
    expect(result.violationCount).toBeGreaterThan(0)
  })
})

describe('AuditChainVerifier — concurrent execution safety', () => {
  it('concurrent runs against different DB instances produce identical valid results', async () => {
    const chain = buildValidChain(10)
    const concurrency = 5

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => {
        const db = createMockDb(chain)
        return new AuditChainVerifier(db).verify()
      }),
    )

    for (const result of results) {
      expect(result.valid).toBe(true)
      expect(result.rowsChecked).toBe(10)
      expect(result.violationCount).toBe(0)
    }
  })

  it('concurrent runs with a tampered chain all detect the same first violation', async () => {
    const chain = buildValidChain(5)
    chain[2].action = 'TAMPERED'

    const results = await Promise.all(
      Array.from({ length: 4 }, () => {
        const db = createMockDb(chain)
        return new AuditChainVerifier(db).verify()
      }),
    )

    for (const result of results) {
      expect(result.valid).toBe(false)
      expect(result.firstViolationSeq).toBe(3)
    }
  })
})

describe('AuditChainVerifier — stale / repeated state', () => {
  it('a second verify() on a repaired chain (new DB mock) returns valid', async () => {
    // First run: tampered chain
    const tamperedChain = buildValidChain(3)
    tamperedChain[1].action = 'TAMPERED'
    const db1 = createMockDb(tamperedChain)
    const verifier1 = new AuditChainVerifier(db1)
    const result1 = await verifier1.verify()
    expect(result1.valid).toBe(false)

    // Second run on the same instance, but now the DB returns a clean chain.
    // Because verify() resets all local state at the start of each call,
    // this must pass cleanly.
    const cleanChain = buildValidChain(3)
    const db2 = createMockDb(cleanChain)
    const verifier2 = new AuditChainVerifier(db2)
    const result2 = await verifier2.verify()
    expect(result2.valid).toBe(true)
    expect(result2.rowsChecked).toBe(3)
  })
})
