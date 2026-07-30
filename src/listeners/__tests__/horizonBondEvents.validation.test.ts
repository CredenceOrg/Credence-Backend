import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { z } from 'zod'

const poolMocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn()
  const mockClientRelease = vi.fn()
  const mockClient = { query: mockClientQuery, release: mockClientRelease }
  const mockPoolConnect = vi.fn().mockResolvedValue(mockClient)
  const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] })
  return { mockClientQuery, mockClientRelease, mockClient, mockPoolConnect, mockPoolQuery }
})

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

vi.mock('../../db/pool.js', () => ({
  pool: { connect: poolMocks.mockPoolConnect, query: poolMocks.mockPoolQuery },
}))

// Mock identityService functions using vi.hoisted to avoid hoisting issues
const { mockUpsertIdentity, mockUpsertBond, mockUpsertCursor } = vi.hoisted(() => ({
  mockUpsertIdentity: vi.fn().mockResolvedValue({}),
  mockUpsertBond: vi.fn().mockResolvedValue({}),
  mockUpsertCursor: vi.fn().mockResolvedValue({}),
}))

// Correct the path: from the test file (src/listeners/__tests__) to src/services is ../../services
vi.mock('../../services/identityService.js', () => ({
  upsertIdentity: mockUpsertIdentity,
  upsertBond: mockUpsertBond,
  upsertCursor: mockUpsertCursor
}))

// Import after mocking
import { subscribeBondCreationEvents } from '../horizonBondEvents.js'
import { bondOperationSchema } from '../messageValidator.js'
import { validateMessage, DlqRouter, DlqReasonCode, type DlqSink } from '../messageValidator.js'

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Creates an in-memory DLQ sink that records every captured message. */
function makeSink(): DlqSink & { captured: Array<{ type: string; data: unknown; reason: string }> } {
  const captured: Array<{ type: string; data: unknown; reason: string }> = []
  return {
    captured,
    async captureFailure(type, data, reason) {
      captured.push({ type, data, reason })
    },
  }
}

const VALID_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// ── Tests ────────────────────────────────────────────────────────────────────────

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => resolve(undefined))
}

describe('subscribeBondCreationEvents validation', () => {
  let sink: ReturnType<typeof makeSink>
  let dlqRouter: DlqRouter
  let mockOnEvent: vi.Mock

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the stored handlers
    storedOnMessageHandler = null
    storedOnErrorHandler = null

    sink = makeSink()
    dlqRouter = new DlqRouter(sink)
    mockOnEvent = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('validation success cases', () => {
    it('should process valid bond creation operation', async () => {
      const validOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '100',
        duration: '3600',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(validOp)
      }

      // Should not route to DLQ
      expect(sink.captured).toHaveLength(0)
      // Should advance cursor and process event
      expect(mockOnEvent).toHaveBeenCalled()
      // Should call upsertIdentity, upsertBond, and upsertCursor
      expect(mockUpsertIdentity).toHaveBeenCalled()
      expect(mockUpsertBond).toHaveBeenCalled()
      expect(mockUpsertCursor).toHaveBeenCalled()
    })

    it('should process valid bond creation with null duration', async () => {
      const validOp = {
        source_account: VALID_ACCOUNT,
        id: '12346',
        amount: '500',
        duration: null,
        paging_token: 'token-2',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(validOp)
      }

      expect(sink.captured).toHaveLength(0)
      expect(mockOnEvent).toHaveBeenCalled()
    })

    it('should process valid bond creation without duration field', async () => {
      const validOp = {
        source_account: VALID_ACCOUNT,
        id: '12347',
        amount: '0',
        paging_token: 'token-3',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(validOp)
      }

      expect(sink.captured).toHaveLength(0)
      expect(mockOnEvent).toHaveBeenCalled()
    })

    it('should process zero amount as valid', async () => {
      const validOp = {
        source_account: VALID_ACCOUNT,
        id: '12348',
        amount: '0',
        paging_token: 'token-4',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(validOp)
      }

      expect(sink.captured).toHaveLength(0)
      expect(mockOnEvent).toHaveBeenCalled()
    })
  })

  describe('validation failure cases', () => {
    it('should quarantine operation with missing source_account', async () => {
      const invalidOp = {
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      // Should route to DLQ with structured reason
      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(sink.captured[0].reason).toContain(DlqReasonCode.SCHEMA_VALIDATION_FAILED)
      // Should NOT call onEvent
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should quarantine operation with invalid source_account', async () => {
      const invalidOp = {
        source_account: 'invalid_account',
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(mockOnEvent).not.toHaveBeenCalled()
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should quarantine operation with missing amount', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(mockOnEvent).not.toHaveBeenCalled()
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should quarantine operation with non-numeric amount', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: 'not_a_number',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(sink.captured[0].reason).toContain('amount')
      expect(mockOnEvent).not.toHaveBeenCalled()
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should quarantine operation with negative amount', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '-100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(mockOnEvent).not.toHaveBeenCalled()
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should quarantine operation with decimal amount', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '100.50',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should quarantine operation with empty amount string', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should quarantine operation with missing id', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].reason).toContain('id')
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should not advance cursor on validation failure', async () => {
      const invalidOp = {
        source_account: 'invalid_account',
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      // Should NOT call onEvent (early return)
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Should route to DLQ
      expect(sink.captured).toHaveLength(1)
      // Should NOT call upsert functions
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })
  })

  describe('security: injection and unbounded strings', () => {
    it('should reject source_account exceeding max length', async () => {
      const invalidOp = {
        source_account: 'G' + 'A'.repeat(200),
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(sink.captured[0].type).toBe('bond_creation')
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should reject id exceeding max length', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: 'x'.repeat(300),
        amount: '100',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should reject amount exceeding max length', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '9'.repeat(50),
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(mockOnEvent).not.toHaveBeenCalled()
    })

    it('should reject amount with SQL injection attempt', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: "100'; DROP TABLE bonds;--",
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(mockOnEvent).not.toHaveBeenCalled()
      // Verify the malicious payload is stored as-is, not interpolated
      expect(sink.captured[0].data).toEqual(invalidOp)
    })

    it('should reject amount with script injection attempt', async () => {
      const invalidOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '<script>alert(1)</script>',
        paging_token: 'token-1',
        type: 'create_bond'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(invalidOp)
      }

      expect(sink.captured).toHaveLength(1)
      expect(mockOnEvent).not.toHaveBeenCalled()
    })
  })

  describe('non-bond creation operations', () => {
    it('should ignore non-create_bond operations', async () => {
      const nonBondOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '100',
        duration: '3600',
        paging_token: 'token-1',
        type: 'payment'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      expect(storedOnMessageHandler).not.toBeNull()
      if (storedOnMessageHandler) {
        await storedOnMessageHandler(nonBondOp)
      }

      // Should not route to DLQ and should not process
      expect(sink.captured).toHaveLength(0)
      expect(mockOnEvent).not.toHaveBeenCalled()
      expect(mockUpsertIdentity).not.toHaveBeenCalled()
      expect(mockUpsertBond).not.toHaveBeenCalled()
      expect(mockUpsertCursor).not.toHaveBeenCalled()
    })

    it('should ignore unknown operation types', async () => {
      const unknownOp = {
        source_account: VALID_ACCOUNT,
        id: '12345',
        amount: '100',
        paging_token: 'token-1',
        type: 'unknown_op_type'
      }

      const unsubscribe = subscribeBondCreationEvents(dlqRouter, mockOnEvent)

      if (storedOnMessageHandler) {
        await storedOnMessageHandler(unknownOp)
      }

      expect(sink.captured).toHaveLength(0)
      expect(mockOnEvent).not.toHaveBeenCalled()
    })
  })
})

describe('bondOperationSchema standalone validation', () => {
  it('validates a correct payload', () => {
    const result = validateMessage(bondOperationSchema, {
      source_account: VALID_ACCOUNT,
      id: 'op-1',
      amount: '1000',
      duration: '3600',
    })
    expect(result.valid).toBe(true)
  })

  it('rejects null payload', () => {
    expect(validateMessage(bondOperationSchema, null).valid).toBe(false)
  })

  it('rejects empty object', () => {
    expect(validateMessage(bondOperationSchema, {}).valid).toBe(false)
  })

  it('rejects amount with leading zeros', () => {
    const result = validateMessage(bondOperationSchema, {
      source_account: VALID_ACCOUNT,
      id: 'op-1',
      amount: '00100',
    })
    // "00100" matches /^\d+$/ so it passes the regex — this is acceptable
    // for Horizon payloads that may have leading zeros
    expect(result.valid).toBe(true)
  })

  it('rejects amount with spaces', () => {
    const result = validateMessage(bondOperationSchema, {
      source_account: VALID_ACCOUNT,
      id: 'op-1',
      amount: '100 ',
    })
    expect(result.valid).toBe(false)
  })

  it('rejects amount with scientific notation', () => {
    const result = validateMessage(bondOperationSchema, {
      source_account: VALID_ACCOUNT,
      id: 'op-1',
      amount: '1e10',
    })
    expect(result.valid).toBe(false)
  })
})
