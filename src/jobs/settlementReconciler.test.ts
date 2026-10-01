import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettlementReconciler } from './settlementReconciler.js'
import * as metrics from '../middleware/metrics.js'

vi.mock('../middleware/metrics.js', () => ({
  recordSettlementDrift: vi.fn(),
  setSettlementUnmatchedCount: vi.fn(),
}))

const transactionCall = vi.fn()
vi.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: class {
    transactions() { return { transaction: () => ({ call: transactionCall }) } }
  } },
}))

const now = new Date('2026-09-29T12:00:00.000Z')
const settlement = (overrides: Record<string, unknown> = {}) => ({
  id: 'settlement-1', status: 'settled', transaction_hash: 'tx-1', amount: '100.00',
  updated_at: new Date(now.getTime() - 600_000), ...overrides,
})

describe('SettlementReconciler', () => {
  let rows: ReturnType<typeof settlement>[]
  let logs: string[]
  let db: { query: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.clearAllMocks()
    rows = []
    logs = []
    db = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM settlements')) return { rows }
      if (sql.includes('INSERT INTO settlement_reconciliation_findings')) return { rows: [{ id: 'finding-1', created_at: now }] }
      if (sql.includes('INSERT INTO settlement_reconciliation_runs')) return { rows: [{ id: 'run-1' }] }
      return { rows: [], rowCount: 1 }
    }) }
  })
  afterEach(() => vi.useRealTimers())

  const run = (db: { query: ReturnType<typeof vi.fn> }, logs: string[]) =>
    new SettlementReconciler(db as any, { logger: (message) => logs.push(message) }).run()

  it('records a matching transaction without a finding', async () => {
    rows = [settlement()]
    transactionCall.mockResolvedValueOnce({ successful: true })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 0, errors: 0 })
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(metrics.recordSettlementDrift).not.toHaveBeenCalled()
    expect(metrics.setSettlementUnmatchedCount).toHaveBeenCalledWith(0)
  })

  it('skips recent pending work and checks exactly at the grace boundary', async () => {
    rows = [
      settlement({ id: 'recent', status: 'pending', updated_at: new Date(now.getTime() - 299_999) }),
      settlement({ id: 'boundary', status: 'pending', updated_at: new Date(now.getTime() - 300_000) }),
    ]
    transactionCall.mockResolvedValueOnce({ successful: true })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 0 })
    expect(transactionCall).toHaveBeenCalledOnce()
    expect(db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO settlement_reconciliation_findings'))?.[1]?.[0]).toBe('boundary')
  })

  it('records a Horizon 404 as a missing transaction', async () => {
    rows = [settlement()]
    transactionCall.mockRejectedValueOnce({ response: { status: 404 } })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 0 })
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('missing_on_chain')
  })

  it('counts a transient Horizon failure and permits a later retry', async () => {
    rows = [settlement()]
    transactionCall.mockRejectedValueOnce({ response: { status: 503 } })
    transactionCall.mockResolvedValueOnce({ successful: false })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 0, errors: 1 })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 0 })
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO settlement_reconciliation_findings'))).toHaveLength(1)
  })

  it('skips a row with no transaction hash and keeps provider errors out of logs', async () => {
    rows = [settlement({ transaction_hash: '' }), settlement({ id: 'failed' })]
    transactionCall.mockRejectedValueOnce(Object.assign(new Error('private provider response'), { response: { status: 503 } }))
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 0, errors: 1 })
    expect(logs.join('\n')).not.toContain('private provider response')
    expect(logs.join('\n')).toContain('status=503')
  })

  it('keeps a finding observable when the run summary cannot be persisted', async () => {
    rows = [settlement()]
    transactionCall.mockResolvedValueOnce({ successful: false })
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('INSERT INTO settlement_reconciliation_runs')
        ? Promise.reject(new Error('private database detail')) : original(sql, params))
    expect(await run(db, logs)).toEqual({ runId: null, checked: 1, discrepancies: 1, errors: 0 })
    expect(db.query.mock.calls.some(([sql]) => sql.includes('UPDATE settlement_reconciliation_findings'))).toBe(false)
    expect(logs.join('\n')).not.toContain('private database detail')
  })

  it('counts a finding write failure without classifying its 404 as a chain failure', async () => {
    rows = [settlement()]
    transactionCall.mockResolvedValueOnce({ successful: false })
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('INSERT INTO settlement_reconciliation_findings')
        ? Promise.reject(Object.assign(new Error('db failure'), { response: { status: 404 } }))
        : original(sql, params))
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 1 })
    expect(metrics.recordSettlementDrift).not.toHaveBeenCalledWith('missing_on_chain')
    expect(logs.some((message) => message.includes('Failed to save finding'))).toBe(true)
  })

  it('links only the finding version written by this run', async () => {
    rows = [settlement()]
    transactionCall.mockResolvedValueOnce({ successful: false })
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 0 })
    const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO settlement_reconciliation_findings'))!
    const link = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE settlement_reconciliation_findings'))!
    expect(insert[0]).toContain('run_id = NULL')
    expect(insert[0]).toContain('RETURNING id, created_at')
    expect(link[0]).toContain('WHERE id = $2 AND created_at = $3 AND run_id IS NULL')
    expect(link[1]).toEqual(['run-1', 'finding-1', now])
  })

  it('reports a failed finding link in both result and run summary', async () => {
    rows = [settlement()]
    transactionCall.mockResolvedValueOnce({ successful: false })
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('UPDATE settlement_reconciliation_findings')
        ? Promise.reject(new Error('link failed')) : original(sql, params))
    expect(await run(db, logs)).toEqual({ runId: 'run-1', checked: 1, discrepancies: 1, errors: 1 })
    expect(db.query.mock.calls.find(([sql]) => sql.includes('UPDATE settlement_reconciliation_runs'))?.[1]).toEqual(['run-1', 1])
  })
})
