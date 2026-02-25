import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SlashService } from './slashService.js'
import { SlashStatus } from './types.js'
import type { CreateSlashRequestInput } from './types.js'

// Mock the database pool
vi.mock('../../db/pool.js', () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(),
  })),
}))

import { getPool } from '../../db/pool.js'

describe('SlashService', () => {
  let service: SlashService
  let mockQuery: ReturnType<typeof vi.fn>

  const VALID_ADDRESS_1 = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const VALID_ADDRESS_2 = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'

  beforeEach(() => {
    service = new SlashService()
    mockQuery = vi.fn()
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as any)
  })

  describe('createSlashRequest', () => {
    const validInput: CreateSlashRequestInput = {
      targetAddress: VALID_ADDRESS_1,
      amount: '100.5',
      reason: 'Malicious behavior detected with evidence',
      evidenceRef: 'https://evidence.example.com/case-123',
      submittedBy: VALID_ADDRESS_2,
    }

    it('should create a slash request successfully', async () => {
      const mockRow = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        target_address: validInput.targetAddress,
        amount: validInput.amount,
        reason: validInput.reason,
        evidence_ref: validInput.evidenceRef,
        status: 'pending',
        submitted_by: validInput.submittedBy,
        submitted_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockQuery.mockResolvedValue({ rows: [mockRow] })

      const result = await service.createSlashRequest(validInput)

      expect(result.id).toBe(mockRow.id)
      expect(result.targetAddress).toBe(validInput.targetAddress)
      expect(result.status).toBe(SlashStatus.PENDING)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO slash_requests'),
        [
          validInput.targetAddress,
          validInput.amount,
          validInput.reason,
          validInput.evidenceRef,
          validInput.submittedBy,
        ]
      )
    })

    it('should reject invalid input', async () => {
      const invalidInput = { ...validInput, targetAddress: 'INVALID' }

      await expect(service.createSlashRequest(invalidInput)).rejects.toThrow('Validation failed')
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('should reject self-slash attempt', async () => {
      const selfSlashInput = {
        ...validInput,
        targetAddress: VALID_ADDRESS_2,
        submittedBy: VALID_ADDRESS_2,
      }

      await expect(service.createSlashRequest(selfSlashInput)).rejects.toThrow('yourself')
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValue(new Error('Database connection failed'))

      await expect(service.createSlashRequest(validInput)).rejects.toThrow('Failed to create')
    })
  })

  describe('getSlashRequestById', () => {
    it('should return slash request when found', async () => {
      const mockRow = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        target_address: VALID_ADDRESS_1,
        amount: '100.5',
        reason: 'Test reason',
        evidence_ref: 'https://evidence.example.com',
        status: 'pending',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockQuery.mockResolvedValue({ rows: [mockRow] })

      const result = await service.getSlashRequestById(mockRow.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(mockRow.id)
      expect(result?.status).toBe(SlashStatus.PENDING)
    })

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] })

      const result = await service.getSlashRequestById('non-existent-id')

      expect(result).toBeNull()
    })
  })

  describe('listSlashRequests', () => {
    it('should list all requests without filters', async () => {
      const mockRows = [
        {
          id: '1',
          target_address: VALID_ADDRESS_1,
          amount: '100',
          reason: 'Reason 1',
          evidence_ref: 'Evidence 1',
          status: 'pending',
          submitted_by: VALID_ADDRESS_2,
          submitted_at: new Date(),
          reviewed_by: null,
          reviewed_at: null,
          review_notes: null,
          executed_at: null,
          execution_tx_hash: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]

      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: mockRows })

      const result = await service.listSlashRequests()

      expect(result.data).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(result.limit).toBe(50)
      expect(result.offset).toBe(0)
    })

    it('should filter by status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] })

      const result = await service.listSlashRequests({ status: SlashStatus.APPROVED })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = $1'),
        expect.arrayContaining([SlashStatus.APPROVED])
      )
    })

    it('should support pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [] })

      const result = await service.listSlashRequests({ limit: 10, offset: 20 })

      expect(result.limit).toBe(10)
      expect(result.offset).toBe(20)
    })
  })

  describe('reviewSlashRequest', () => {
    it('should approve a pending request', async () => {
      const pendingRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        target_address: VALID_ADDRESS_1,
        amount: '100',
        reason: 'Test',
        evidence_ref: 'Evidence',
        status: 'pending',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      const approvedRequest = {
        ...pendingRequest,
        status: 'approved',
        reviewed_by: VALID_ADDRESS_2,
        reviewed_at: new Date(),
        review_notes: 'Approved',
      }

      mockQuery
        .mockResolvedValueOnce({ rows: [pendingRequest] })
        .mockResolvedValueOnce({ rows: [approvedRequest] })

      const result = await service.reviewSlashRequest({
        id: pendingRequest.id,
        status: SlashStatus.APPROVED,
        reviewedBy: VALID_ADDRESS_2,
        reviewNotes: 'Approved',
      })

      expect(result.status).toBe(SlashStatus.APPROVED)
      expect(result.reviewedBy).toBe(VALID_ADDRESS_2)
    })

    it('should reject invalid status transition', async () => {
      const executedRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'executed',
        target_address: VALID_ADDRESS_1,
        amount: '100',
        reason: 'Test',
        evidence_ref: 'Evidence',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: VALID_ADDRESS_2,
        reviewed_at: new Date(),
        review_notes: 'Approved',
        executed_at: new Date(),
        execution_tx_hash: 'abc123',
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockQuery.mockResolvedValueOnce({ rows: [executedRequest] })

      await expect(
        service.reviewSlashRequest({
          id: executedRequest.id,
          status: SlashStatus.APPROVED,
          reviewedBy: VALID_ADDRESS_2,
        })
      ).rejects.toThrow('executed')
    })
  })

  describe('executeSlashRequest', () => {
    it('should execute an approved request', async () => {
      const approvedRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'approved',
        target_address: VALID_ADDRESS_1,
        amount: '100',
        reason: 'Test',
        evidence_ref: 'Evidence',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: VALID_ADDRESS_2,
        reviewed_at: new Date(),
        review_notes: 'Approved',
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      const executedRequest = {
        ...approvedRequest,
        status: 'executed',
        executed_at: new Date(),
        execution_tx_hash: 'abc123def456',
      }

      mockQuery
        .mockResolvedValueOnce({ rows: [approvedRequest] })
        .mockResolvedValueOnce({ rows: [executedRequest] })

      const result = await service.executeSlashRequest({
        id: approvedRequest.id,
        executionTxHash: 'abc123def456',
      })

      expect(result.status).toBe(SlashStatus.EXECUTED)
      expect(result.executionTxHash).toBe('abc123def456')
    })

    it('should reject execution of pending request', async () => {
      const pendingRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'pending',
        target_address: VALID_ADDRESS_1,
        amount: '100',
        reason: 'Test',
        evidence_ref: 'Evidence',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockQuery.mockResolvedValueOnce({ rows: [pendingRequest] })

      await expect(
        service.executeSlashRequest({
          id: pendingRequest.id,
          executionTxHash: 'abc123',
        })
      ).rejects.toThrow()
    })

    it('should require execution transaction hash', async () => {
      const approvedRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'approved',
        target_address: VALID_ADDRESS_1,
        amount: '100',
        reason: 'Test',
        evidence_ref: 'Evidence',
        submitted_by: VALID_ADDRESS_2,
        submitted_at: new Date(),
        reviewed_by: VALID_ADDRESS_2,
        reviewed_at: new Date(),
        review_notes: 'Approved',
        executed_at: null,
        execution_tx_hash: null,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockQuery.mockResolvedValueOnce({ rows: [approvedRequest] })

      await expect(
        service.executeSlashRequest({
          id: approvedRequest.id,
          executionTxHash: '',
        })
      ).rejects.toThrow('transaction hash')
    })
  })
})
