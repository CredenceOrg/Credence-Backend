import { describe, it, expect } from 'vitest'
import { computeLastVerifiedHeight, toChainVerificationState } from './chainStatus.js'
import type { ChainVerificationResult } from './types.js'

describe('computeLastVerifiedHeight', () => {
  it('returns lastCheckedSeq for a valid chain', () => {
    const result: ChainVerificationResult = {
      valid: true,
      rowsChecked: 5,
      lastCheckedSeq: 5,
      violationCount: 0,
      violations: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    expect(computeLastVerifiedHeight(result)).toBe(5)
  })

  it('returns zero for an empty valid chain', () => {
    const result: ChainVerificationResult = {
      valid: true,
      rowsChecked: 0,
      lastCheckedSeq: 0,
      violationCount: 0,
      violations: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    expect(computeLastVerifiedHeight(result)).toBe(0)
  })

  it('returns seq before first break when tampering is detected', () => {
    const result: ChainVerificationResult = {
      valid: false,
      rowsChecked: 5,
      lastCheckedSeq: 5,
      firstViolationSeq: 3,
      violationCount: 1,
      violations: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    expect(computeLastVerifiedHeight(result)).toBe(2)
  })

  it('returns zero when the first row breaks the chain', () => {
    const result: ChainVerificationResult = {
      valid: false,
      rowsChecked: 1,
      lastCheckedSeq: 1,
      firstViolationSeq: 1,
      violationCount: 1,
      violations: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    expect(computeLastVerifiedHeight(result)).toBe(0)
  })
})

describe('toChainVerificationState', () => {
  it('maps a break result with firstBreakSeq', () => {
    const result: ChainVerificationResult = {
      valid: false,
      rowsChecked: 4,
      lastCheckedSeq: 4,
      firstViolationSeq: 4,
      violationCount: 1,
      violations: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    }

    expect(toChainVerificationState(result)).toEqual({
      lastVerifiedHeight: 3,
      verifiedAt: '2025-01-01T00:00:00.000Z',
      status: 'break_detected',
      firstBreakSeq: 4,
      violationCount: 1,
      rowsChecked: 4,
    })
  })
})
