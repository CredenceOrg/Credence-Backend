import { describe, it, expect } from 'vitest'
import {
  attestationEventSchema,
  withdrawalEventSchema,
  bondCreationEventSchema,
} from './queue.js'

// ── Attestation event schema ───────────────────────────────────────────────

describe('attestationEventSchema', () => {
  const validAdd = {
    id: 'op-1',
    pagingToken: 'cursor-1',
    type: 'add',
    subject: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    weight: 80,
    claim: 'KYC passed',
    createdAt: '2024-01-15T10:30:00.000Z',
    transactionHash: 'deadbeef01234567',
  }

  it('accepts a well-formed add event', () => {
    expect(attestationEventSchema.safeParse(validAdd).success).toBe(true)
  })

  it('accepts a revoke event with empty claim', () => {
    const result = attestationEventSchema.safeParse({ ...validAdd, type: 'revoke', claim: '' })
    expect(result.success).toBe(true)
  })

  it('accepts a createdAt with timezone offset', () => {
    const result = attestationEventSchema.safeParse({
      ...validAdd,
      createdAt: '2024-01-15T10:30:00+05:30',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown event type', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, type: 'update' }).success).toBe(false)
  })

  it('rejects weight above 100', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, weight: 101 }).success).toBe(false)
  })

  it('rejects weight below 0', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, weight: -1 }).success).toBe(false)
  })

  it('rejects a non-integer weight', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, weight: 50.5 }).success).toBe(false)
  })

  it('rejects a missing id', () => {
    const { id: _id, ...rest } = validAdd
    expect(attestationEventSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, id: '' }).success).toBe(false)
  })

  it('rejects a malformed createdAt (plain date only)', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, createdAt: '2024-01-15' }).success).toBe(false)
  })

  it('rejects a createdAt that is not a date at all', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, createdAt: 'not-a-date' }).success).toBe(false)
  })

  it('rejects an empty transaction hash', () => {
    expect(attestationEventSchema.safeParse({ ...validAdd, transactionHash: '' }).success).toBe(false)
  })

  it('rejects a null payload', () => {
    expect(attestationEventSchema.safeParse(null).success).toBe(false)
  })

  it('rejects a completely empty object', () => {
    expect(attestationEventSchema.safeParse({}).success).toBe(false)
  })

  it('surfaces a human-readable error for invalid type', () => {
    const result = attestationEventSchema.safeParse({ ...validAdd, type: 'bad' })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Zod v4 uses .issues; v3 used .errors (aliased in v4)
      const issues = (result.error as any).issues ?? (result.error as any).errors ?? []
      expect(issues.some((e: { path: (string | number)[] }) => e.path.includes('type'))).toBe(true)
    }
  })
})

// ── Withdrawal event schema ────────────────────────────────────────────────

describe('withdrawalEventSchema', () => {
  const validWithdrawal = {
    id: 'op-2',
    pagingToken: 'cursor-2',
    type: 'payment',
    createdAt: new Date('2024-01-15T10:30:00.000Z'),
    bondId: 'bond-abc123',
    account: 'GABC123XYZ',
    amount: '500.0000000',
    assetType: 'native',
    transactionHash: 'cafebabe0123',
    operationIndex: 0,
  }

  it('accepts a well-formed withdrawal event with a Date object', () => {
    expect(withdrawalEventSchema.safeParse(validWithdrawal).success).toBe(true)
  })

  it('accepts an ISO-8601 string for createdAt', () => {
    const result = withdrawalEventSchema.safeParse({
      ...validWithdrawal,
      createdAt: '2024-01-15T10:30:00.000Z',
    })
    expect(result.success).toBe(true)
  })

  it('accepts optional assetCode and assetIssuer', () => {
    const result = withdrawalEventSchema.safeParse({
      ...validWithdrawal,
      assetCode: 'USDC',
      assetIssuer: 'GAISSUER123',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a zero amount', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, amount: '0' }).success).toBe(true)
  })

  it('accepts a large operationIndex', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, operationIndex: 9999 }).success).toBe(true)
  })

  it('rejects a negative amount string', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, amount: '-1.0' }).success).toBe(false)
  })

  it('rejects a non-numeric amount string', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, amount: 'abc' }).success).toBe(false)
  })

  it('rejects an amount with a leading minus sign', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, amount: '-0' }).success).toBe(false)
  })

  it('rejects a negative operationIndex', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, operationIndex: -1 }).success).toBe(false)
  })

  it('rejects a non-integer operationIndex', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, operationIndex: 1.5 }).success).toBe(false)
  })

  it('rejects a missing bondId', () => {
    const { bondId: _id, ...rest } = validWithdrawal
    expect(withdrawalEventSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty account', () => {
    expect(withdrawalEventSchema.safeParse({ ...validWithdrawal, account: '' }).success).toBe(false)
  })

  it('rejects a null payload', () => {
    expect(withdrawalEventSchema.safeParse(null).success).toBe(false)
  })
})

// ── Bond creation event schema ─────────────────────────────────────────────

describe('bondCreationEventSchema', () => {
  const validBond = {
    id: 'op-3',
    type: 'create_bond' as const,
    sourceAccount: 'GABCBONDACCOUNT123',
    amount: '1000.0000000',
    duration: '90',
  }

  it('accepts a well-formed bond creation event', () => {
    expect(bondCreationEventSchema.safeParse(validBond).success).toBe(true)
  })

  it('accepts null duration', () => {
    expect(bondCreationEventSchema.safeParse({ ...validBond, duration: null }).success).toBe(true)
  })

  it('accepts missing duration (undefined)', () => {
    const { duration: _d, ...rest } = validBond
    expect(bondCreationEventSchema.safeParse(rest).success).toBe(true)
  })

  it('accepts optional pagingToken', () => {
    const result = bondCreationEventSchema.safeParse({
      ...validBond,
      pagingToken: 'cursor-99',
    })
    expect(result.success).toBe(true)
  })

  it('accepts optional transactionHash', () => {
    const result = bondCreationEventSchema.safeParse({
      ...validBond,
      transactionHash: 'abc123def456',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a wrong event type discriminant', () => {
    expect(bondCreationEventSchema.safeParse({ ...validBond, type: 'payment' }).success).toBe(false)
  })

  it('rejects a missing type', () => {
    const { type: _t, ...rest } = validBond
    expect(bondCreationEventSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty sourceAccount', () => {
    expect(bondCreationEventSchema.safeParse({ ...validBond, sourceAccount: '' }).success).toBe(false)
  })

  it('rejects a non-decimal amount', () => {
    expect(bondCreationEventSchema.safeParse({ ...validBond, amount: 'one thousand' }).success).toBe(false)
  })

  it('rejects a negative amount', () => {
    expect(bondCreationEventSchema.safeParse({ ...validBond, amount: '-100' }).success).toBe(false)
  })

  it('rejects a null payload', () => {
    expect(bondCreationEventSchema.safeParse(null).success).toBe(false)
  })
})
