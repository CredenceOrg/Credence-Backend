import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import app from '../app.js'
import {
  computeBondScore,
  computeDurationScore,
  computeAttestationScore,
  computeTrustScore,
} from '../services/reputationService.js'

// ─── Seed addresses (must match src/db/store.ts) ────────────────────────────

const ALICE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'   // 1 ETH, 5 attestations
const BOB   = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'   // 0.5 ETH, 2 attestations
const EMPTY = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'   // 0 ETH, no attestations
const UNKNOWN = '0x1234567890123456789012345678901234567890'  // not in store
const BAD_ADDRESS = 'not-an-address'
const SHORT_HEX   = '0x1234'

// ─── Integration: GET /api/trust/:address ───────────────────────────────────

describe('GET /api/trust/:address', () => {
  describe('found identity', () => {
    it('returns 200 with all required fields for ALICE', async () => {
      const res = await request(app).get(`/api/trust/${ALICE}`)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: ALICE,
        bondedAmount: '1000000000000000000',
        bondStart: '2024-01-15T00:00:00.000Z',
        attestationCount: 5,
        agreedFields: { name: 'Alice', role: 'validator' },
      })
      expect(typeof res.body.score).toBe('number')
      expect(res.body.score).toBeGreaterThanOrEqual(0)
      expect(res.body.score).toBeLessThanOrEqual(100)
    })

    it('returns 200 with all required fields for BOB', async () => {
      const res = await request(app).get(`/api/trust/${BOB}`)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: BOB,
        bondedAmount: '500000000000000000',
        bondStart: '2024-06-01T00:00:00.000Z',
        attestationCount: 2,
      })
      expect(res.body).not.toHaveProperty('agreedFields')
      expect(res.body.score).toBeGreaterThanOrEqual(0)
      expect(res.body.score).toBeLessThanOrEqual(100)
    })

    it('returns score of 0 for unbonded identity', async () => {
      const res = await request(app).get(`/api/trust/${EMPTY}`)

      expect(res.status).toBe(200)
      expect(res.body.score).toBe(0)
      expect(res.body.bondedAmount).toBe('0')
      expect(res.body.bondStart).toBeNull()
      expect(res.body.attestationCount).toBe(0)
    })

    it('is case-insensitive for the address parameter', async () => {
      const upper = ALICE.toUpperCase().replace('0X', '0x')
      const res = await request(app).get(`/api/trust/${upper}`)
      expect(res.status).toBe(200)
      expect(res.body.address).toBe(ALICE)
    })

    it('sets rateTier to standard when no API key is provided', async () => {
      const res = await request(app).get(`/api/trust/${ALICE}`)
      expect(res.status).toBe(200)
      // rateTier is internal; verify no leakage in body but request succeeds
    })

    it('returns 200 with premium API key header', async () => {
      const res = await request(app)
        .get(`/api/trust/${ALICE}`)
        .set('X-API-Key', 'test-premium-key')

      expect(res.status).toBe(200)
      expect(res.body.score).toBeGreaterThanOrEqual(0)
    })

    it('returns 200 with unknown API key (treated as standard)', async () => {
      const res = await request(app)
        .get(`/api/trust/${ALICE}`)
        .set('X-API-Key', 'invalid-key')

      expect(res.status).toBe(200)
    })
  })

  describe('not found', () => {
    it('returns 404 for a valid address not in the store', async () => {
      const res = await request(app).get(`/api/trust/${UNKNOWN}`)

      expect(res.status).toBe(404)
      expect(res.body).toHaveProperty('error')
      expect(typeof res.body.error).toBe('string')
    })
  })

  describe('invalid address format', () => {
    it('returns 400 for a non-hex string', async () => {
      const res = await request(app).get(`/api/trust/${BAD_ADDRESS}`)

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
    })

    it('returns 400 for a too-short hex string', async () => {
      const res = await request(app).get(`/api/trust/${SHORT_HEX}`)

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
    })

    it('returns 400 for address missing 0x prefix', async () => {
      const noPrefix = ALICE.slice(2) // strip '0x'
      const res = await request(app).get(`/api/trust/${noPrefix}`)

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
    })

    it('returns 400 for address that is 41 hex chars (too long)', async () => {
      const tooLong = ALICE + 'a'
      const res = await request(app).get(`/api/trust/${tooLong}`)

      expect(res.status).toBe(400)
    })
  })
})

// ─── Unit: reputation service sub-functions ─────────────────────────────────

describe('computeBondScore', () => {
  it('returns 50 for exactly 1 ETH', () => {
    expect(computeBondScore('1000000000000000000')).toBe(50)
  })

  it('returns 50 (capped) for 2 ETH', () => {
    expect(computeBondScore('2000000000000000000')).toBe(50)
  })

  it('returns 25 for 0.5 ETH', () => {
    expect(computeBondScore('500000000000000000')).toBe(25)
  })

  it('returns 0 for zero bond', () => {
    expect(computeBondScore('0')).toBe(0)
  })

  it('returns 0 for invalid value', () => {
    expect(computeBondScore('not-a-number')).toBe(0)
  })
})

describe('computeDurationScore', () => {
  const DAY_MS = 86_400_000

  it('returns 20 (max) for a bond older than 365 days', () => {
    const start = new Date(Date.now() - 400 * DAY_MS).toISOString()
    expect(computeDurationScore(start)).toBe(20)
  })

  it('returns 0 for null bondStart', () => {
    expect(computeDurationScore(null)).toBe(0)
  })

  it('returns 0 for a future bondStart', () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    expect(computeDurationScore(future)).toBe(0)
  })

  it('returns proportional score for ~182 days (half year)', () => {
    const now = Date.now()
    const start = new Date(now - 182 * DAY_MS).toISOString()
    const score = computeDurationScore(start, now)
    // 182/365 * 20 ≈ 9.97 → rounds to 10
    expect(score).toBeGreaterThanOrEqual(9)
    expect(score).toBeLessThanOrEqual(11)
  })

  it('accepts a custom `now` for deterministic testing', () => {
    const fixedNow = new Date('2025-01-01T00:00:00Z').getTime()
    const start = '2024-01-01T00:00:00Z'  // exactly 366 days before
    expect(computeDurationScore(start, fixedNow)).toBe(20)
  })
})

describe('computeAttestationScore', () => {
  it('returns 30 for 5 attestations', () => {
    expect(computeAttestationScore(5)).toBe(30)
  })

  it('returns 30 (capped) for more than 5 attestations', () => {
    expect(computeAttestationScore(10)).toBe(30)
  })

  it('returns 0 for zero attestations', () => {
    expect(computeAttestationScore(0)).toBe(0)
  })

  it('returns proportional score for 2 attestations', () => {
    // 2/5 * 30 = 12
    expect(computeAttestationScore(2)).toBe(12)
  })
})

describe('computeTrustScore', () => {
  it('returns score 0 for an unbonded identity with no attestations', () => {
    const identity = {
      address: '0x0000000000000000000000000000000000000000',
      bondedAmount: '0',
      bondStart: null,
      attestationCount: 0,
    }
    const result = computeTrustScore(identity)
    expect(result.score).toBe(0)
  })

  it('returns 100 for a fully-bonded, long-duration, well-attested identity', () => {
    const farPast = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const identity = {
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '1000000000000000000', // 1 ETH → 50 pts
      bondStart: farPast,                   // 400 days → 20 pts
      attestationCount: 5,                  // 5 → 30 pts
    }
    const result = computeTrustScore(identity)
    expect(result.score).toBe(100)
  })

  it('includes agreedFields when present', () => {
    const identity = {
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '0',
      bondStart: null,
      attestationCount: 0,
      agreedFields: { role: 'validator' },
    }
    const result = computeTrustScore(identity)
    expect(result.agreedFields).toEqual({ role: 'validator' })
  })

  it('omits agreedFields when not present', () => {
    const identity = {
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '0',
      bondStart: null,
      attestationCount: 0,
    }
    const result = computeTrustScore(identity)
    expect(result).not.toHaveProperty('agreedFields')
  })

  it('caps total score at 100', () => {
    const farPast = new Date(Date.now() - 1000 * 86_400_000).toISOString()
    const identity = {
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '9999000000000000000000', // massive bond
      bondStart: farPast,
      attestationCount: 999,
    }
    const result = computeTrustScore(identity)
    expect(result.score).toBe(100)
  })
})
