import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verificationService } from '../../src/services/verificationService.js'

describe('VerificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('verifyBulkChunked', () => {
    it('should chunk correctly', async () => {
      // Create a fake identity service implementation
      const verifyBulkMock = vi.fn().mockImplementation((addresses: string[]) => {
        return Promise.resolve({
          results: addresses.map(addr => ({ address: addr, valid: true })),
          errors: []
        })
      })

      // We need to mock the dynamic import of IdentityService
      vi.doMock('../../src/services/identityService.js', () => ({
        IdentityService: vi.fn().mockImplementation(() => ({
          verifyBulk: verifyBulkMock
        }))
      }))

      const addresses = Array.from({ length: 110 }, (_, i) => `0x${i}`)
      
      const { results, errors } = await verificationService.verifyBulkChunked(addresses, 50)
      
      expect(results).toHaveLength(110)
      expect(errors).toHaveLength(0)
      // With chunkSize 50 and 110 addresses, it should be called 3 times (50, 50, 10)
      expect(verifyBulkMock).toHaveBeenCalledTimes(3)
      expect(verifyBulkMock.mock.calls[0][0]).toHaveLength(50)
      expect(verifyBulkMock.mock.calls[1][0]).toHaveLength(50)
      expect(verifyBulkMock.mock.calls[2][0]).toHaveLength(10)
    })
  })

  describe('enqueueBulkVerification', () => {
    it('should persist a job using mocked repo', async () => {
      const createJobMock = vi.fn().mockResolvedValue({ id: 'job_123' })
      
      vi.doMock('../../src/db/repositories/bulkJobRepository.js', () => ({
        BulkJobRepository: vi.fn().mockImplementation(() => ({
          create: createJobMock
        }))
      }))
      
      vi.doMock('../../src/db/pool.js', () => ({
        workerPool: {}
      }))

      const addresses = ['0x1', '0x2']
      const jobId = await verificationService.enqueueBulkVerification(addresses, { orgId: 'org_1', size: 2 })
      
      expect(jobId).toBe('job_123')
      expect(createJobMock).toHaveBeenCalledWith('org_1', 2, { addresses })
    })
  })
})
