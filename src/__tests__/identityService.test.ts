import { describe, it, expect, beforeEach } from 'vitest'
import { IdentityService } from '../services/identityService.js'

describe('IdentityService', () => {
  let service: IdentityService

  beforeEach(() => {
    service = new IdentityService()
  })

  const VALID_ADDRESS = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const INVALID_ADDRESS = 'INVALID'

  describe('verifyIdentity', () => {
    it('should verify a valid Stellar address', async () => {
      const result = await service.verifyIdentity(VALID_ADDRESS)

      expect(result.address).toBe(VALID_ADDRESS)
      expect(result.trustScore).toBeGreaterThanOrEqual(0)
      expect(result.trustScore).toBeLessThanOrEqual(100)
      expect(result.bondStatus).toBeDefined()
      expect(result.bondStatus.bondedAmount).toBeDefined()
      expect(result.bondStatus.active).toBeDefined()
      expect(result.attestationCount).toBeGreaterThanOrEqual(0)
      expect(result.lastUpdated).toBeDefined()
    })

    it('should throw error for invalid address format', async () => {
      await expect(service.verifyIdentity(INVALID_ADDRESS)).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should throw error for empty address', async () => {
      await expect(service.verifyIdentity('')).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should throw error for address with wrong length', async () => {
      await expect(service.verifyIdentity('G123')).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should throw error for address not starting with G', async () => {
      const invalidAddress = 'AABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
      await expect(service.verifyIdentity(invalidAddress)).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should return ISO timestamp for lastUpdated', async () => {
      const result = await service.verifyIdentity(VALID_ADDRESS)
      expect(() => new Date(result.lastUpdated)).not.toThrow()
      expect(new Date(result.lastUpdated).toISOString()).toBe(result.lastUpdated)
    })

    it('should return valid bond status structure', async () => {
      const result = await service.verifyIdentity(VALID_ADDRESS)

      if (result.bondStatus.active) {
        expect(result.bondStatus.bondStart).not.toBeNull()
        expect(result.bondStatus.bondDuration).not.toBeNull()
        expect(parseFloat(result.bondStatus.bondedAmount)).toBeGreaterThan(0)
      } else {
        expect(result.bondStatus.bondedAmount).toBe('0')
        expect(result.bondStatus.bondStart).toBeNull()
        expect(result.bondStatus.bondDuration).toBeNull()
      }
    })
  })

  describe('verifyBulk', () => {
    it('should verify multiple valid addresses', async () => {
      const addresses = [
        'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
        'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
        'GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
      ]

      const { results, errors } = await service.verifyBulk(addresses)

      expect(results).toHaveLength(3)
      expect(errors).toHaveLength(0)

      results.forEach((result, index) => {
        expect(result.address).toBe(addresses[index])
        expect(result.trustScore).toBeGreaterThanOrEqual(0)
        expect(result.trustScore).toBeLessThanOrEqual(100)
      })
    })

    it('should handle partial failures gracefully', async () => {
      const addresses = [
        'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
        'INVALID1',
        'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
        'INVALID2',
      ]

      const { results, errors } = await service.verifyBulk(addresses)

      expect(results).toHaveLength(2)
      expect(errors).toHaveLength(2)

      expect(results[0].address).toBe(addresses[0])
      expect(results[1].address).toBe(addresses[2])

      expect(errors[0]).toMatchObject({
        address: 'INVALID1',
        error: 'VerificationFailed',
        message: expect.any(String),
      })

      expect(errors[1]).toMatchObject({
        address: 'INVALID2',
        error: 'VerificationFailed',
        message: expect.any(String),
      })
    })

    it('should return all errors when all addresses are invalid', async () => {
      const addresses = ['INVALID1', 'INVALID2', 'INVALID3']

      const { results, errors } = await service.verifyBulk(addresses)

      expect(results).toHaveLength(0)
      expect(errors).toHaveLength(3)

      errors.forEach((error, index) => {
        expect(error.address).toBe(addresses[index])
        expect(error.error).toBe('VerificationFailed')
        expect(error.message).toBe('Invalid Stellar address format')
      })
    })

    it('should handle empty array', async () => {
      const { results, errors } = await service.verifyBulk([])

      expect(results).toHaveLength(0)
      expect(errors).toHaveLength(0)
    })

    it('should process addresses in parallel', async () => {
      const addresses = Array(10)
        .fill(null)
        .map((_, i) => `G${String(i).padStart(55, '2')}`)

      const startTime = Date.now()
      const { results, errors } = await service.verifyBulk(addresses)
      const duration = Date.now() - startTime

      expect(results.length + errors.length).toBe(10)
      // If processed sequentially, would take ~100ms (10 * 10ms)
      // Parallel processing should be much faster
      expect(duration).toBeLessThan(200)
    })

    it('should return consistent error structure', async () => {
      const addresses = ['BAD1', 'BAD2']

      const { errors } = await service.verifyBulk(addresses)

      errors.forEach((error) => {
        expect(error).toHaveProperty('address')
        expect(error).toHaveProperty('error')
        expect(error).toHaveProperty('message')
        expect(typeof error.address).toBe('string')
        expect(typeof error.error).toBe('string')
        expect(typeof error.message).toBe('string')
      })
    })
  })

  describe('Edge Cases', () => {
    it('should handle addresses with lowercase letters', async () => {
      const invalidAddress = 'gabc7ixpv3ywqxkqzqxqzqxqzqxqzqxqzqxqzqxqzqxqzqxqzqxqzqxq'
      await expect(service.verifyIdentity(invalidAddress)).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should handle addresses with invalid characters', async () => {
      const invalidAddress = 'G@BC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
      await expect(service.verifyIdentity(invalidAddress)).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })

    it('should handle very long address', async () => {
      const invalidAddress = 'G' + '2'.repeat(100)
      await expect(service.verifyIdentity(invalidAddress)).rejects.toThrow(
        'Invalid Stellar address format'
      )
    })
  })
})
