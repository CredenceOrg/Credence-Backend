import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TrustService } from './index.js'

// Mock the db module
vi.mock('../db.js', () => ({
  getDbPool: vi.fn(),
}))

import { getDbPool } from '../db.js'

describe('TrustService', () => {
  let mockPool: any
  let service: TrustService

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    }
    ;(getDbPool as any).mockReturnValue(mockPool)
    service = new TrustService()
  })

  describe('getTrustScore', () => {
    it('returns null when no record found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] })

      const result = await service.getTrustScore('0x1234567890123456789012345678901234567890')

      expect(result).toBeNull()
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT address, bonded_amount, bond_start, bond_duration, active, attestation_count, agreed_fields FROM identities WHERE address = $1',
        ['0x1234567890123456789012345678901234567890']
      )
    })

    it('calculates score correctly for fully bonded identity', async () => {
      const mockRecord = {
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bonded_amount: '1000000000000000000', // 1 ETH
        bond_start: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60), // 1 year ago
        bond_duration: 365 * 24 * 60 * 60, // 1 year
        active: true,
        attestation_count: 5,
        agreed_fields: { name: 'Alice', role: 'validator' },
      }
      mockPool.query.mockResolvedValue({ rows: [mockRecord] })

      const result = await service.getTrustScore('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')

      expect(result).toMatchObject({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        score: 100, // 50 + 20 + 30
        bondedAmount: '1000000000000000000',
        attestationCount: 5,
        agreedFields: { name: 'Alice', role: 'validator' },
      })
      expect(result!.bondStart).toBeTruthy()
    })

    it('calculates score correctly for partial bond', async () => {
      const mockRecord = {
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        bonded_amount: '500000000000000000', // 0.5 ETH
        bond_start: Math.floor(Date.now() / 1000) - (180 * 24 * 60 * 60), // 6 months ago
        bond_duration: 180 * 24 * 60 * 60, // 6 months
        active: true,
        attestation_count: 2,
        agreed_fields: null,
      }
      mockPool.query.mockResolvedValue({ rows: [mockRecord] })

      const result = await service.getTrustScore('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')

      expect(result).toMatchObject({
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        score: 46, // 25 (0.5 ETH) + 9 (6 months) + 12 (2 attestations)
        bondedAmount: '500000000000000000',
        attestationCount: 2,
      })
      expect(result!.agreedFields).toBeUndefined()
    })

    it('returns zero score for unbonded identity', async () => {
      const mockRecord = {
        address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
        bonded_amount: '0',
        bond_start: null,
        bond_duration: null,
        active: false,
        attestation_count: 0,
        agreed_fields: null,
      }
      mockPool.query.mockResolvedValue({ rows: [mockRecord] })

      const result = await service.getTrustScore('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc')

      expect(result).toMatchObject({
        address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })
    })

    it('normalizes address to lowercase', async () => {
      mockPool.query.mockResolvedValue({ rows: [] })

      await service.getTrustScore('0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266')

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266']
      )
    })
  })
})