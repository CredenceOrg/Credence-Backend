import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BondService } from './index.js'

// Mock the db module
vi.mock('../db.js', () => ({
  getDbPool: vi.fn(),
}))

import { getDbPool } from '../db.js'

describe('BondService', () => {
  let mockPool: any
  let service: BondService

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    }
    ;(getDbPool as any).mockReturnValue(mockPool)
    service = new BondService()
  })

  describe('getBondStatus', () => {
    it('returns null when no record found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] })

      const result = await service.getBondStatus('0x1234567890123456789012345678901234567890')

      expect(result).toBeNull()
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT address, bonded_amount, bond_start, bond_duration, active FROM identities WHERE address = $1',
        ['0x1234567890123456789012345678901234567890']
      )
    })

    it('returns bond status for known identity', async () => {
      const mockRecord = {
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bonded_amount: '1000000000000000000',
        bond_start: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60),
        bond_duration: 365 * 24 * 60 * 60,
        active: true,
      }
      mockPool.query.mockResolvedValue({ rows: [mockRecord] })

      const result = await service.getBondStatus('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')

      expect(result).toMatchObject({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '1000000000000000000',
        active: true,
      })
      expect(result!.bondStart).toBeTruthy()
      expect(result!.bondDuration).toBe(365 * 24 * 60 * 60)
    })

    it('normalizes address to lowercase', async () => {
      mockPool.query.mockResolvedValue({ rows: [] })

      await service.getBondStatus('0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266')

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266']
      )
    })
  })
})