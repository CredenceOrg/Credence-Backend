import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import express from 'express'
import { getDbPool, closeDbPool } from '../../src/services/db.js'
import { createHealthRouter } from '../../src/routes/health.js'
import { createDefaultProbes } from '../../src/services/health/probes.js'
import { TrustService } from '../../src/services/trust/index.js'
import { BondService } from '../../src/services/bond/index.js'

// Test data
const testIdentities = [
  {
    address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    bonded_amount: '1000000000000000000', // 1 ETH
    bond_start: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60), // 1 year ago
    bond_duration: 365 * 24 * 60 * 60, // 1 year
    active: true,
    attestation_count: 5,
    agreed_fields: { name: 'Alice', role: 'validator' },
  },
  {
    address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    bonded_amount: '500000000000000000', // 0.5 ETH
    bond_start: Math.floor(Date.now() / 1000) - (180 * 24 * 60 * 60), // 6 months ago
    bond_duration: 180 * 24 * 60 * 60, // 6 months
    active: true,
    attestation_count: 2,
    agreed_fields: null,
  },
  {
    address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    bonded_amount: '0',
    bond_start: null,
    bond_duration: null,
    active: false,
    attestation_count: 0,
    agreed_fields: null,
  },
]

function createTestApp() {
  const app = express()
  app.use(express.json())

  const healthProbes = createDefaultProbes()
  app.use('/api/health', createHealthRouter(healthProbes))

  const trustService = new TrustService()
  const bondService = new BondService()

  function isValidAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address)
  }

  app.get('/api/trust/:address', async (req, res) => {
    const { address } = req.params

    if (!isValidAddress(address)) {
      return res.status(400).json({
        error: 'Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters.'
      })
    }

    try {
      const trustScore = await trustService.getTrustScore(address)
      if (!trustScore) {
        return res.status(404).json({
          error: `No identity record found for address ${address}.`
        })
      }
      res.json(trustScore)
    } catch (error) {
      console.error('Error fetching trust score:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.get('/api/bond/:address', async (req, res) => {
    const { address } = req.params

    if (!isValidAddress(address)) {
      return res.status(400).json({
        error: 'Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters.'
      })
    }

    try {
      const bondStatus = await bondService.getBondStatus(address)
      if (!bondStatus) {
        return res.json({
          address,
          bondedAmount: '0',
          bondStart: null,
          bondDuration: null,
          active: false,
        })
      }
      res.json(bondStatus)
    } catch (error) {
      console.error('Error fetching bond status:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return app
}

// Skip integration tests if DATABASE_URL is not set
const hasDb = !!process.env.DATABASE_URL
const testSuite = hasDb ? describe : describe.skip

testSuite('API Integration Tests', () => {
  let app: express.Express
  let pool: any

  beforeAll(async () => {
    pool = getDbPool()

    // Create test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS identities (
        address VARCHAR(42) PRIMARY KEY,
        bonded_amount VARCHAR(78) NOT NULL,
        bond_start BIGINT,
        bond_duration BIGINT,
        active BOOLEAN NOT NULL,
        attestation_count INTEGER NOT NULL DEFAULT 0,
        agreed_fields JSONB
      )
    `)

    // Clear existing data
    await pool.query('DELETE FROM identities')

    // Insert test data
    for (const identity of testIdentities) {
      await pool.query(
        `INSERT INTO identities (address, bonded_amount, bond_start, bond_duration, active, attestation_count, agreed_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          identity.address,
          identity.bonded_amount,
          identity.bond_start,
          identity.bond_duration,
          identity.active,
          identity.attestation_count,
          identity.agreed_fields,
        ]
      )
    }
  })

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS identities')
      await closeDbPool()
    }
  })

  describe('GET /api/health', () => {
    it('returns 200 and service health', async () => {
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('credence-backend')
    })
  })

  describe('GET /api/trust/:address', () => {
    it('returns 200 and trust score for known address with full bond', async () => {
      const address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      const res = await request(app).get(`/api/trust/${address}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: address.toLowerCase(),
        score: 100, // 50 (bond) + 20 (duration) + 30 (attestations)
        bondedAmount: '1000000000000000000',
        attestationCount: 5,
        agreedFields: { name: 'Alice', role: 'validator' },
      })
      expect(res.body.bondStart).toBeTruthy()
    })

    it('returns 200 and trust score for known address with partial bond', async () => {
      const address = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
      const res = await request(app).get(`/api/trust/${address}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: address.toLowerCase(),
        score: 57, // ~25 (0.5 ETH) + ~10 (6 months) + 12 (2 attestations)
        bondedAmount: '500000000000000000',
        attestationCount: 2,
      })
      expect(res.body.bondStart).toBeTruthy()
      expect(res.body.agreedFields).toBeUndefined()
    })

    it('returns 200 and zero score for unbonded address', async () => {
      const address = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
      const res = await request(app).get(`/api/trust/${address}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: address.toLowerCase(),
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })
      expect(res.body.agreedFields).toBeUndefined()
    })

    it('returns 404 for unknown address', async () => {
      const address = '0x1234567890123456789012345678901234567890'
      const res = await request(app).get(`/api/trust/${address}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('No identity record found')
    })

    it('returns 400 for invalid address format', async () => {
      const res = await request(app).get('/api/trust/invalid-address')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid address format')
    })

    it('handles case-insensitive addresses', async () => {
      const address = '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266' // uppercase
      const res = await request(app).get(`/api/trust/${address}`)
      expect(res.status).toBe(200)
      expect(res.body.address).toBe(address.toLowerCase())
    })
  })

  describe('GET /api/bond/:address', () => {
    it('returns 200 and bond status for known bonded address', async () => {
      const address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      const res = await request(app).get(`/api/bond/${address}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: address.toLowerCase(),
        bondedAmount: '1000000000000000000',
        active: true,
      })
      expect(res.body.bondStart).toBeTruthy()
      expect(res.body.bondDuration).toBe(365 * 24 * 60 * 60)
    })

    it('returns 200 and zeroed bond status for unknown address', async () => {
      const address = '0x1234567890123456789012345678901234567890'
      const res = await request(app).get(`/api/bond/${address}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        address: address.toLowerCase(),
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
      })
    })

    it('returns 400 for invalid address format', async () => {
      const res = await request(app).get('/api/bond/invalid-address')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid address format')
    })
  })

  // TODO: Add rate limiting and auth tests when implemented
})