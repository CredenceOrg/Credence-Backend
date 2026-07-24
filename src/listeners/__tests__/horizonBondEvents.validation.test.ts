import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { z } from 'zod'

// Variables to store references to mock functions we need to access in tests
let storedOnMessageHandler: vi.Mock | null = null
let storedOnErrorHandler: vi.Mock | null = null

// Mock Stellar SDK before importing the module
vi.mock('@stellar/stellar-sdk', () => {
  const mockOperations = vi.fn()
  const mockStream = vi.fn()
  
  const mockStrKey = {
    isValidEd25519PublicKey: vi.fn().mockImplementation((account: string) => {
      // Return true for valid-looking Stellar accounts (starting with G, reasonable length)
      return typeof account === 'string' && account.startsWith('G') && account.length >= 56;
    }),
    isValidMuxedAccount: vi.fn().mockReturnValue(false)
  }
  
  const mockServer = {
    operations: mockOperations
      .mockReturnValue({
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        cursor: vi.fn().mockReturnThis(),
        forAsset: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          cursor: vi.fn().mockReturnThis(),
          stream: vi.fn().mockImplementation((options: any) => {
            // Store references to the handler functions so we can call them in tests
            storedOnMessageHandler = vi.fn().mockImplementation(options.onmessage)
            storedOnErrorHandler = vi.fn().mockImplementation(options.onerror)
            return mockStream
          })
        }),
        stream: vi.fn().mockImplementation((options: any) => {
          // Store references to the handler functions so we can call them in tests
          storedOnMessageHandler = vi.fn().mockImplementation(options.onmessage)
          storedOnErrorHandler = vi.fn().mockImplementation(options.onerror)
          return mockStream
        })
      })
  }

  return {
    Horizon: {
      Server: class MockServer {
        constructor(url: string) {
          return mockServer as any
        }
      }
    },
    StrKey: mockStrKey
  }
})

// Mock identityService functions using vi.hoisted to avoid hoisting issues
const { mockUpsertIdentity, mockUpsertBond } = vi.hoisted(() => ({
  mockUpsertIdentity: vi.fn().mockResolvedValue({}),
  mockUpsertBond: vi.fn().mockResolvedValue({}),
}))

// Correct the path: from the test file (src/listeners/__tests__) to src/services is ../../services
vi.mock('../../services/identityService.js', () => ({
  upsertIdentity: mockUpsertIdentity,
  upsertBond: mockUpsertBond
}))

// Import after mocking
import { subscribeBondCreationEvents } from '../horizonBondEvents.js'
import { bondOperationSchema } from '../messageValidator.js'
import { validateMessage } from '../messageValidator.js'

describe('subscribeBondCreationEvents validation', () => {
  let mockReplayService: {
    captureFailure: vi.Mock
  }
  let mockOnEvent: vi.Mock

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the stored handlers
    storedOnMessageHandler = null
    storedOnErrorHandler = null
    
    mockReplayService = {
      captureFailure: vi.fn().mockResolvedValue(undefined)
    }
    mockOnEvent = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('validation success cases', () => {
    it('should process valid bond creation operation', async () => {
      // Test with a known valid pattern
      const validAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      
      const validOp = {
        source_account: validAccount, // Valid Stellar account
        id: '12345',
        amount: '100',
        duration: '3600',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the valid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(validOp)
      }
      
      // Should not call captureFailure
      expect(mockReplayService.captureFailure).not.toHaveBeenCalled()
      // Should advance cursor and process event
      expect(mockOnEvent).toHaveBeenCalled()
      // Should call upsertIdentity and upsertBond
      expect(mockUpsertIdentity).toHaveBeenCalled()
      expect(mockUpsertBond).toHaveBeenCalled()
    })
  })

  describe('validation failure cases', () => {
    it('should quarantine operation with missing source_account', async () => {
      const invalidOp = {
        // Missing source_account
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should call captureFailure with the operation
      expect(mockReplayService.captureFailure).toHaveBeenCalledWith(
        'bond_creation',
        invalidOp,
        expect.stringContaining('source_account')
      )
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })

    it('should quarantine operation with invalid source_account', async () => {
      const invalidOp = {
        source_account: 'invalid_account',
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should call captureFailure
      expect(mockReplayService.captureFailure).toHaveBeenCalled()
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })

    it('should quarantine operation with missing amount', async () => {
      const invalidOp = {
        source_account: 'GABCD...',
        id: '12345',
        // Missing amount
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should call captureFailure
      expect(mockReplayService.captureFailure).toHaveBeenCalled()
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })

    it('should quarantine operation with non-numeric amount', async () => {
      const invalidOp = {
        source_account: 'GABCD...',
        id: '12345',
        amount: 'not_a_number',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should call captureFailure
      expect(mockReplayService.captureFailure).toHaveBeenCalled()
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })

    it('should quarantine operation with negative amount', async () => {
      const invalidOp = {
        source_account: 'GABCD...',
        id: '12345',
        amount: '-100', // Negative number
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should call captureFailure
      expect(mockReplayService.captureFailure).toHaveBeenCalled()
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })

    it('should not advance cursor on validation failure', async () => {
      const invalidOp = {
        source_account: 'invalid_account',
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the invalid operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }
      
      // Should NOT call onEvent (early return)
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should call captureFailure
      expect(mockReplayService.captureFailure).toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })
  })

  describe('non-bond creation operations', () => {
    it('should ignore non-create_bond operations', async () => {
      const nonBondOp = {
        source_account: 'GABCD...',
        id: '12345',
        amount: '100',
        duration: '3600',
        paging_token: 'token-1',
        type: 'payment' // Not a create_bond operation
      }

      const unsubscribe = subscribeBondCreationEvents(mockReplayService, mockOnEvent)
      
      // Call the stored onMessage handler with the non-bond operation
      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(nonBondOp)
      }
      
      // Should still validate the operation (to check format)
      // But should not process it as a bond creation
      expect(mockReplayService.captureFailure).not.toHaveBeenCalled()
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
    })
  })
})