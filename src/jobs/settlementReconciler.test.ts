import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SettlementReconciler } from './settlementReconciler.js'
import * as metrics from '../middleware/metrics.js'

// Mock recordSettlementDrift helper
vi.mock('../middleware/metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/metrics.js')>()
  return {
    ...actual,
    recordSettlementDrift: vi.fn(),
  }
})

// Setup a global mock function for transaction call
const mockTransactionCall = vi.fn()

vi.mock('@stellar/stellar-sdk', () => {
  return {
    Horizon: {
      Server: class MockServer {
        transactions() {
          return {
            transaction: () => {
              return {
                call: mockTransactionCall,
              }
            },
          }
        }
      },
    },
  }
})

describe('SettlementReconciler', () => {
  let mockDb: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
  })

  it('matching records produce no findings', async () => {
    // DB returns one settled settlement
    const settlement = {
      id: 'settlement-1',
      status: 'settled',
      transaction_hash: 'tx-hash-1',
      amount: '100.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
    }
    mockDb.query.mockResolvedValueOnce({ rows: [settlement] })

    // Horizon returns transaction was successful
    mockTransactionCall.mockResolvedValueOnce({ successful: true })

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    expect(result).toEqual({ checked: 1, discrepancies: 0, errors: 0 })
    expect(mockTransactionCall).toHaveBeenCalledOnce()
    // No findings should be written to DB
    expect(mockDb.query).toHaveBeenCalledTimes(1) // only the initial select
    expect(metrics.recordSettlementDrift).not.toHaveBeenCalled()
  })

  it('mismatches produce findings (state_mismatch)', async () => {
    // DB returns one settled settlement
    const settlement = {
      id: 'settlement-2',
      status: 'settled',
      transaction_hash: 'tx-hash-2',
      amount: '200.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    mockDb.query.mockResolvedValueOnce({ rows: [settlement] })

    // Horizon returns transaction failed on-chain
    mockTransactionCall.mockResolvedValueOnce({ successful: false })

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    expect(result).toEqual({ checked: 1, discrepancies: 1, errors: 0 })
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('state_mismatch')
    
    // Finding should be persisted in DB
    expect(mockDb.query).toHaveBeenCalledTimes(2) // select + insert
    expect(mockDb.query.mock.calls[1][0]).toContain('INSERT INTO settlement_reconciliation_findings')
    expect(mockDb.query.mock.calls[1][1]).toEqual([
      'settlement-2',
      'state_mismatch',
      expect.any(String), // JSON stringified details
    ])

    const details = JSON.parse(mockDb.query.mock.calls[1][1][2])
    expect(details.internalStatus).toBe('settled')
    expect(details.chainStatus).toBe('failed')
  })

  it('missing transaction on-chain produces findings (missing_on_chain)', async () => {
    const settlement = {
      id: 'settlement-3',
      status: 'settled',
      transaction_hash: 'tx-hash-3',
      amount: '300.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    mockDb.query.mockResolvedValueOnce({ rows: [settlement] })

    // Horizon throws 404
    const err: any = new Error('Not Found')
    err.response = { status: 404 }
    mockTransactionCall.mockRejectedValueOnce(err)

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    expect(result).toEqual({ checked: 1, discrepancies: 1, errors: 0 })
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('missing_on_chain')

    // Finding should be persisted in DB
    expect(mockDb.query).toHaveBeenCalledTimes(2)
    expect(mockDb.query.mock.calls[1][1][1]).toBe('missing_on_chain')
  })

  it('skips recent pending settlements within grace period', async () => {
    const recentSettlement = {
      id: 'settlement-recent',
      status: 'pending',
      transaction_hash: 'tx-hash-recent',
      amount: '150.00',
      updated_at: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes old (grace period is 5 minutes)
    }
    mockDb.query.mockResolvedValueOnce({ rows: [recentSettlement] })

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    // Should skip check
    expect(result).toEqual({ checked: 0, discrepancies: 0, errors: 0 })
    expect(mockTransactionCall).not.toHaveBeenCalled()
  })

  it('checks pending settlements older than grace period', async () => {
    const oldSettlement = {
      id: 'settlement-old',
      status: 'pending',
      transaction_hash: 'tx-hash-old',
      amount: '150.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes old
    }
    mockDb.query.mockResolvedValueOnce({ rows: [oldSettlement] })

    // Horizon returns transaction is successful on chain (meaning it settled on chain but still pending in DB)
    mockTransactionCall.mockResolvedValueOnce({ successful: true })

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    expect(result).toEqual({ checked: 1, discrepancies: 1, errors: 0 })
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('state_mismatch')
  })

  it('handles Horizon errors gracefully without crashing', async () => {
    const settlement = {
      id: 'settlement-err',
      status: 'settled',
      transaction_hash: 'tx-hash-err',
      amount: '400.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    mockDb.query.mockResolvedValueOnce({ rows: [settlement] })

    // Horizon returns 500 internal server error
    const err: any = new Error('Internal Server Error')
    err.response = { status: 500 }
    mockTransactionCall.mockRejectedValueOnce(err)

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    // Errors count should increment, discrepancies should not, and should not crash
    expect(result).toEqual({ checked: 1, discrepancies: 0, errors: 1 })
    expect(mockDb.query).toHaveBeenCalledTimes(1) // only initial select
  })

  it('reconciles multiple settlements with partial visibility', async () => {
    const s1 = {
      id: 'settlement-s1',
      status: 'settled',
      transaction_hash: 'tx-hash-s1',
      amount: '10.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    const s2 = {
      id: 'settlement-s2',
      status: 'settled',
      transaction_hash: 'tx-hash-s2',
      amount: '20.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    const s3 = {
      id: 'settlement-s3',
      status: 'settled',
      transaction_hash: 'tx-hash-s3',
      amount: '30.00',
      updated_at: new Date(Date.now() - 10 * 60 * 1000),
    }
    mockDb.query.mockResolvedValueOnce({ rows: [s1, s2, s3] })

    // Horizon outputs:
    mockTransactionCall
      .mockResolvedValueOnce({ successful: true }) // s1 matches
      .mockResolvedValueOnce({ successful: false }) // s2 mismatch
      .mockRejectedValueOnce({ response: { status: 404 } }) // s3 missing

    const reconciler = new SettlementReconciler(mockDb)
    const result = await reconciler.run()

    expect(result).toEqual({ checked: 3, discrepancies: 2, errors: 0 })
    expect(metrics.recordSettlementDrift).toHaveBeenCalledTimes(2)
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('state_mismatch')
    expect(metrics.recordSettlementDrift).toHaveBeenCalledWith('missing_on_chain')
    expect(mockDb.query).toHaveBeenCalledTimes(3) // select + s2 insert + s3 insert
  })
})
