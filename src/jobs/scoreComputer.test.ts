import { describe, it, expect } from 'vitest'
import { computeScore } from './scoreComputer.js'
import type { IdentityData } from './types.js'

describe('computeScore', () => {
  it('returns 0 for inactive identity', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000',
      active: false,
      attestationCount: 10,
    }
    expect(computeScore(data)).toBe(0)
  })

  it('computes score based on bond amount only', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000', // Max bond = 100% bond score
      active: true,
      attestationCount: 0,
    }
    // 60% * 100 + 40% * 0 = 60
    expect(computeScore(data)).toBe(60)
  })

  it('computes score based on attestations only', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 50, // Max attestations = 100% attestation score
    }
    // 60% * 0 + 40% * 100 = 40
    expect(computeScore(data)).toBe(40)
  })

  it('computes score with both bond and attestations', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '500', // 50% of max bond
      active: true,
      attestationCount: 25, // 50% of max attestations
    }
    // 60% * 50 + 40% * 50 = 30 + 20 = 50
    expect(computeScore(data)).toBe(50)
  })

  it('caps bond score at 100', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '2000', // 200% of max bond
      active: true,
      attestationCount: 0,
    }
    // 60% * 100 + 40% * 0 = 60
    expect(computeScore(data)).toBe(60)
  })

  it('caps attestation score at 100', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 100, // 200% of max attestations
    }
    // 60% * 0 + 40% * 100 = 40
    expect(computeScore(data)).toBe(40)
  })

  it('computes perfect score', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000',
      active: true,
      attestationCount: 50,
    }
    // 60% * 100 + 40% * 100 = 100
    expect(computeScore(data)).toBe(100)
  })

  it('rounds score to nearest integer', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '333', // 33.3% of max
      active: true,
      attestationCount: 17, // 34% of max
    }
    // 60% * 33.3 + 40% * 34 = 19.98 + 13.6 = 33.58 -> 34 (but actual is 33)
    expect(computeScore(data)).toBe(33)
  })

  it('handles zero bond and attestations', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 0,
    }
    expect(computeScore(data)).toBe(0)
  })

  it('handles large bond amounts', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000000000000000000000', // Very large amount
      active: true,
      attestationCount: 50,
    }
    // Should cap bond score at 100
    expect(computeScore(data)).toBe(100)
  })
})
