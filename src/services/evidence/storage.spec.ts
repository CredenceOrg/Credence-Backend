import { EvidenceStorageService } from './storage.js'

describe('EvidenceStorageService', () => {
  let service: EvidenceStorageService

  beforeAll(() => {
    // Set environment variable for testing
    process.env.EVIDENCE_ENCRYPTION_KEY = '12345678901234567890123456789012'
    service = new EvidenceStorageService()
  })

  it('should upload and retrieve encrypted evidence successfully for an ARBITRATOR', async () => {
    const evidenceId = 'dispute-123'
    const rawData = 'Screenshot of malicious transaction'

    await service.uploadEvidence(evidenceId, rawData, 'user-1')
    const decrypted = await service.retrieveEvidence(evidenceId, 'ARBITRATOR')

    expect(decrypted).toBe(rawData)
  })

  it('should upload and retrieve encrypted evidence successfully for GOVERNANCE', async () => {
    const evidenceId = 'dispute-124'
    const rawData = 'Dispute log files payload'

    await service.uploadEvidence(evidenceId, rawData, 'user-2')
    const decrypted = await service.retrieveEvidence(evidenceId, 'GOVERNANCE')

    expect(decrypted).toBe(rawData)
  })

  it('should deny access to standard USER roles', async () => {
    const evidenceId = 'dispute-125'
    await service.uploadEvidence(evidenceId, 'secret data', 'user-1')

    await expect(service.retrieveEvidence(evidenceId, 'USER')).rejects.toThrow(
      'Unauthorized: Insufficient role permissions'
    )
  })

  it('should throw an error for non-existent evidence', async () => {
    await expect(
      service.retrieveEvidence('fake-id', 'ARBITRATOR')
    ).rejects.toThrow('Evidence not found')
  })

  it('should fail to initialize if key is missing or invalid length', () => {
    process.env.EVIDENCE_ENCRYPTION_KEY = 'short-key'
    expect(() => new EvidenceStorageService()).toThrow(
      'EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.'
    )
  })
})
