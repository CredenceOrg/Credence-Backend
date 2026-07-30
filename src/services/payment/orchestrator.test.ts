import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PaymentOrchestrator } from './orchestrator.js'
import type { SettlementsRepository } from '../../db/repositories/settlementsRepository.js'
import type { PaymentRequest } from './types.js'

// ---------------------------------------------------------------------------
// OTel mock – spans are no-ops so tests focus on business logic only.
// A fresh mock span is created per startActiveSpan call to avoid cross-test
// pollution and allow assertion on individual span interactions.
// ---------------------------------------------------------------------------

const makeMockSpan = () => ({
  setAttributes:  vi.fn(),
  setStatus:      vi.fn(),
  recordException: vi.fn(),
  end:            vi.fn(),
})

vi.mock('../../tracing/tracer.js', () => ({
  PaymentSpans: {
    PROCESS:    'payment.process',
    INGEST:     'payment.ingest',
    VALIDATE:   'payment.validate',
    RISK_CHECK: 'payment.risk_check',
    PROCESSOR:  'payment.processor',
    SETTLE:     'payment.settle',
  },
  getPaymentTracer: () => ({
    startActiveSpan: <T>(_name: string, fn: (span: ReturnType<typeof makeMockSpan>) => Promise<T>): Promise<T> =>
      fn(makeMockSpan()),
  }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Valid 64-char hex transaction hash. */
const VALID_TX = 'a'.repeat(64)

/** Valid Ethereum address. */
const VALID_ETH = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const validRequest: PaymentRequest = {
  bondId:          1,
  amount:          '500000000000000000', // 0.5 ETH in wei
  transactionHash: VALID_TX,
  fromAccount:     VALID_ETH,
}

const mockNow = new Date('2024-06-01T00:00:00.000Z')

// ---------------------------------------------------------------------------
// Repository mock factory
// ---------------------------------------------------------------------------

function makeRepository(
  overrides: Partial<Pick<SettlementsRepository, 'upsert'>> = {},
): SettlementsRepository {
  return {
    upsert: vi.fn().mockResolvedValue({
      settlement: {
        id:              '42',
        bondId:          String(validRequest.bondId),
        amount:          validRequest.amount,
        transactionHash: VALID_TX,
        settledAt:       mockNow,
        status:          'settled',
        createdAt:       mockNow,
        updatedAt:       mockNow,
      },
      isDuplicate: false,
    }),
    ...overrides,
  } as unknown as SettlementsRepository
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentOrchestrator', () => {
  let repository: SettlementsRepository
  let orchestrator: PaymentOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    repository  = makeRepository()
    orchestrator = new PaymentOrchestrator(repository)
  })

  // ── Happy path ──────────────────────────────────────────────────────────

  describe('process – happy path', () => {
    it('returns a settled result for a valid low-risk payment', async () => {
      const result = await orchestrator.process(validRequest)

      expect(result.status).toBe('settled')
      expect(result.transactionHash).toBe(VALID_TX)
      expect(result.settlementId).toBe(42)
      expect(result.processedAt).toBeInstanceOf(Date)
    })

    it('stages show success=true for each stage', async () => {
      const result = await orchestrator.process(validRequest)

      expect(result.stages.validation.success).toBe(true)
      expect(result.stages.riskCheck.approved).toBe(true)
      expect(result.stages.processor.success).toBe(true)
      expect(result.stages.settlement.success).toBe(true)
    })

    it('records non-negative duration for every stage', async () => {
      const result = await orchestrator.process(validRequest)

      expect(result.stages.validation.duration).toBeGreaterThanOrEqual(0)
      expect(result.stages.riskCheck.duration).toBeGreaterThanOrEqual(0)
      expect(result.stages.processor.duration).toBeGreaterThanOrEqual(0)
      expect(result.stages.settlement.duration).toBeGreaterThanOrEqual(0)
    })

    it('passes isDuplicate=false from the repository through to stages', async () => {
      const result = await orchestrator.process(validRequest)
      expect(result.stages.settlement.isDuplicate).toBe(false)
    })

    it('passes isDuplicate=true when the repository reports a duplicate', async () => {
      const repo = makeRepository({
        upsert: vi.fn().mockResolvedValue({
          settlement: {
            id: '7', bondId: '1', amount: validRequest.amount,
            transactionHash: VALID_TX, settledAt: mockNow,
            status: 'settled', createdAt: mockNow, updatedAt: mockNow,
          },
          isDuplicate: true,
        }),
      })
      const result = await new PaymentOrchestrator(repo).process(validRequest)
      expect(result.stages.settlement.isDuplicate).toBe(true)
    })

    it('calls repository.upsert exactly once with the correct input', async () => {
      await orchestrator.process(validRequest)

      expect(repository.upsert).toHaveBeenCalledOnce()
      expect(repository.upsert).toHaveBeenCalledWith({
        bondId:          validRequest.bondId,
        amount:          validRequest.amount,
        transactionHash: VALID_TX,
        status:          'settled',
      })
    })

    it('accepts a valid Stellar account address', async () => {
      const stellarRequest: PaymentRequest = {
        ...validRequest,
        // 56-char Stellar account (G + 55 uppercase base32 chars)
        fromAccount: 'G' + 'A'.repeat(55),
      }
      const result = await orchestrator.process(stellarRequest)
      expect(result.status).toBe('settled')
    })
  })

  // ── Medium-risk payment (passes, riskScore=50) ──────────────────────────

  describe('process – medium risk', () => {
    it('still settles a payment with a medium risk score', async () => {
      // 1 ETH in wei exactly hits the medium threshold
      const mediumRiskRequest: PaymentRequest = {
        ...validRequest,
        amount: '1000000000000000000',
      }
      const result = await orchestrator.process(mediumRiskRequest)
      expect(result.status).toBe('settled')
      expect(result.stages.riskCheck.riskScore).toBe(50)
      expect(result.stages.riskCheck.approved).toBe(true)
    })
  })

  // ── Risk check rejection ────────────────────────────────────────────────

  describe('process – risk check rejection', () => {
    it('returns failed when the amount exceeds the high-risk threshold', async () => {
      const highRiskRequest: PaymentRequest = {
        ...validRequest,
        amount: '10000000000000000000', // exactly 10 ETH → riskScore 90
      }
      const result = await orchestrator.process(highRiskRequest)

      expect(result.status).toBe('failed')
      expect(result.stages.riskCheck.approved).toBe(false)
      expect(result.stages.riskCheck.riskScore).toBe(90)
    })

    it('does not call repository.upsert when risk check fails', async () => {
      const highRiskRequest: PaymentRequest = {
        ...validRequest,
        amount: '99000000000000000000',
      }
      await orchestrator.process(highRiskRequest)
      expect(repository.upsert).not.toHaveBeenCalled()
    })

    it('shows validation as successful in the failed result stages', async () => {
      const highRiskRequest: PaymentRequest = {
        ...validRequest,
        amount: '50000000000000000000',
      }
      const result = await orchestrator.process(highRiskRequest)
      expect(result.stages.validation.success).toBe(true)
    })
  })

  // ── Validation failure ──────────────────────────────────────────────────

  describe('process – validation failures', () => {
    it('returns failed for a zero bondId', async () => {
      const result = await orchestrator.process({ ...validRequest, bondId: 0 })
      expect(result.status).toBe('failed')
      expect(result.stages.validation.success).toBe(false)
    })

    it('returns failed for a negative bondId', async () => {
      const result = await orchestrator.process({ ...validRequest, bondId: -1 })
      expect(result.status).toBe('failed')
      expect(result.stages.validation.success).toBe(false)
    })

    it('returns failed for a non-integer bondId', async () => {
      const result = await orchestrator.process({ ...validRequest, bondId: 1.5 })
      expect(result.status).toBe('failed')
      expect(result.stages.validation.success).toBe(false)
    })

    it('returns failed for a non-hex transactionHash', async () => {
      const result = await orchestrator.process({
        ...validRequest,
        transactionHash: 'not-a-hash',
      })
      expect(result.status).toBe('failed')
      expect(result.stages.validation.success).toBe(false)
    })

    it('returns failed for a transactionHash shorter than 64 chars', async () => {
      const result = await orchestrator.process({
        ...validRequest,
        transactionHash: 'a'.repeat(32),
      })
      expect(result.status).toBe('failed')
    })

    it('returns failed for an invalid fromAccount', async () => {
      const result = await orchestrator.process({
        ...validRequest,
        fromAccount: 'not-an-address',
      })
      expect(result.status).toBe('failed')
    })

    it('does not call repository.upsert when validation fails', async () => {
      await orchestrator.process({ ...validRequest, bondId: 0 })
      expect(repository.upsert).not.toHaveBeenCalled()
    })

    it('zeroes out all downstream stage durations on validation failure', async () => {
      const result = await orchestrator.process({ ...validRequest, bondId: 0 })
      expect(result.stages.riskCheck.duration).toBe(0)
      expect(result.stages.processor.duration).toBe(0)
      expect(result.stages.settlement.duration).toBe(0)
    })
  })

  // ── Settlement repository error ─────────────────────────────────────────

  describe('process – settlement error', () => {
    it('propagates errors thrown by repository.upsert', async () => {
      const dbError = new Error('connection refused')
      const repo    = makeRepository({
        upsert: vi.fn().mockRejectedValue(dbError),
      })
      const orch = new PaymentOrchestrator(repo)

      await expect(orch.process(validRequest)).rejects.toThrow('connection refused')
    })

    it('rethrows non-Error objects from repository.upsert', async () => {
      const repo = makeRepository({
        upsert: vi.fn().mockRejectedValue('string error'),
      })
      const orch = new PaymentOrchestrator(repo)

      await expect(orch.process(validRequest)).rejects.toBeDefined()
    })
  })

  // ── Ingest edge case ────────────────────────────────────────────────────

  describe('process – ingest edge cases', () => {
    it('throws when the amount is an empty string', async () => {
      await expect(
        orchestrator.process({ ...validRequest, amount: '' }),
      ).rejects.toThrow('Payment amount must not be empty')
    })

    it('throws when the amount is whitespace only', async () => {
      await expect(
        orchestrator.process({ ...validRequest, amount: '   ' }),
      ).rejects.toThrow('Payment amount must not be empty')
    })
  })
})
