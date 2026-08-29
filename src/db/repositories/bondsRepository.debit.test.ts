import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { BondsRepository, InsufficientFundsError } from './bondsRepository.js'
import { subtractDecimals } from '../../lib/decimalMath.js'

function makeBondRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    identity_address: '0xIDENTITY',
    amount: '1000000000000000000',
    start_time: new Date('2024-01-01T00:00:00Z'),
    duration_days: 30,
    status: 'active',
    created_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  }
}

/** Builds a mock PoolClient that answers lock/update queries against a single in-memory row. */
function makeMockClient(initialAmount: string) {
  let currentAmount = initialAmount
  const query = vi.fn().mockImplementation((sql: string) => {
    const text = String(sql)
    if (text.includes('FOR UPDATE')) {
      return Promise.resolve({ rows: [makeBondRow({ amount: currentAmount })] })
    }
    if (text.trim().startsWith('UPDATE bonds')) {
      // Real query performs the subtraction in NUMERIC SQL; mimic that exactly
      // via the same decimal-safe helper used elsewhere in the codebase.
      return Promise.resolve({
        rows: [makeBondRow({ amount: currentAmount })],
      })
    }
    return Promise.resolve({ rows: [] })
  })

  const client = { query, release: vi.fn() } as unknown as PoolClient
  return { client, setAmount: (a: string) => (currentAmount = a) }
}

describe('BondsRepository.debit', () => {
  let mockPool: Pool

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('debits successfully when amount is exactly equal to the balance', async () => {
    const { client } = makeMockClient('1000000000000000000')
    mockPool = { connect: vi.fn().mockResolvedValue(client) } as any
    const repo = new BondsRepository(client as any, mockPool)

    const result = await repo.debit(1, '1000000000000000000')

    expect(result.amount).toBe('1000000000000000000')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rejects a debit that exceeds the balance by exactly 1 unit at wei scale (precision-loss regression)', async () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991. Values one above it
    // (9007199254740992 and 9007199254740993) round to the SAME float64
    // value under Number(), so a naive `Number(amount) > Number(balance)`
    // comparison would silently treat an over-limit debit as valid.
    const balance = '9007199254740992'
    const requested = '9007199254740993'

    const { client } = makeMockClient(balance)
    mockPool = { connect: vi.fn().mockResolvedValue(client) } as any
    const repo = new BondsRepository(client as any, mockPool)

    await expect(repo.debit(1, requested)).rejects.toBeInstanceOf(InsufficientFundsError)
    // Must roll back rather than committing a bad debit.
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith('COMMIT')
  })

  it('throws InsufficientFundsError when amount exceeds balance under normal precision', async () => {
    const { client } = makeMockClient('100')
    mockPool = { connect: vi.fn().mockResolvedValue(client) } as any
    const repo = new BondsRepository(client as any, mockPool)

    await expect(repo.debit(1, '150')).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('rejects malformed or non-positive amounts before acquiring the row lock', async () => {
    const { client } = makeMockClient('100')
    mockPool = { connect: vi.fn().mockResolvedValue(client) } as any
    const repo = new BondsRepository(client as any, mockPool)

    await expect(repo.debit(1, '0')).rejects.toThrow('Invalid debit amount')
    await expect(repo.debit(1, '-5')).rejects.toThrow('Invalid debit amount')
    await expect(repo.debit(1, 'abc')).rejects.toThrow('Invalid debit amount')

    // The row lock (and thus a DB round-trip) should never be attempted for invalid input.
    expect(mockPool.connect).not.toHaveBeenCalled()
  })

  it('allows a debit of one unit less than the balance', async () => {
    const balance = '9007199254740993'
    const requested = subtractDecimals(balance, '1')

    const { client } = makeMockClient(balance)
    mockPool = { connect: vi.fn().mockResolvedValue(client) } as any
    const repo = new BondsRepository(client as any, mockPool)

    await expect(repo.debit(1, requested)).resolves.toBeDefined()
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
