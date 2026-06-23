import { SpanStatusCode } from '@opentelemetry/api'
import { getPaymentTracer, PaymentSpans } from '../../tracing/tracer.js'
import type { SettlementsRepository } from '../../db/repositories/settlementsRepository.js'
import type {
  PaymentRequest,
  ValidationResult,
  RiskCheckResult,
  ProcessorResult,
  PaymentResult,
} from './types.js'

// Stellar transaction hash: 64 hex characters
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/
// Ethereum address: 0x + 40 hex chars
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
// Stellar account ID: starts with G, 56 chars total in base32
const STELLAR_ADDR_RE = /^G[A-Z2-7]{55}$/

// Risk thresholds expressed in the smallest unit (e.g. stroops or wei)
const RISK_HIGH_THRESHOLD   = BigInt('10000000000000000000') // 10 ETH equivalent
const RISK_MEDIUM_THRESHOLD = BigInt('1000000000000000000')  // 1 ETH equivalent

/**
 * Orchestrates the full payment processing pipeline with OpenTelemetry spans
 * at every stage to enable latency breakdown in distributed traces.
 *
 * Pipeline stages (each produces an OTel child span):
 *   1. **ingest**      – normalize and record the incoming request
 *   2. **validate**    – structural and format validation of request fields
 *   3. **risk_check**  – amount-based risk scoring
 *   4. **processor**   – submit the payment for on-chain processing
 *   5. **settle**      – persist the settlement record to the database
 */
export class PaymentOrchestrator {
  private readonly tracer = getPaymentTracer()

  /**
   * @param repository - Settlement persistence layer.
   */
  constructor(private readonly repository: SettlementsRepository) {}

  /**
   * Process a payment request through the full pipeline.
   *
   * Every stage is wrapped in its own OTel span so latency can be broken down
   * per stage in Jaeger, Tempo, or any compatible backend.
   *
   * @param request - Incoming payment request to process.
   * @returns A `PaymentResult` with per-stage timing and outcome data.
   */
  async process(request: PaymentRequest): Promise<PaymentResult> {
    return this.tracer.startActiveSpan(PaymentSpans.PROCESS, async (rootSpan) => {
      rootSpan.setAttributes({
        'payment.bond_id':          request.bondId,
        'payment.transaction_hash': request.transactionHash,
        'payment.from_account':     request.fromAccount,
      })

      const processedAt = new Date()

      try {
        // ── Stage 1: ingest ──────────────────────────────────────────────
        await this.ingestPayment(request)

        // ── Stage 2: validate ────────────────────────────────────────────
        const validationStart  = Date.now()
        const validationResult = await this.validatePayment(request)
        const validationMs     = Date.now() - validationStart

        if (!validationResult.valid) {
          rootSpan.setAttributes({ 'payment.outcome': 'validation_failed' })
          return this.failedResult(request.transactionHash, processedAt, {
            validation: { duration: validationMs, success: false },
            riskCheck:  { duration: 0, approved: false, riskScore: 0 },
            processor:  { duration: 0, success: false },
            settlement: { duration: 0, success: false, isDuplicate: false },
          })
        }

        // ── Stage 3: risk check ──────────────────────────────────────────
        const riskStart  = Date.now()
        const riskResult = await this.processRiskCheck(request)
        const riskMs     = Date.now() - riskStart

        if (!riskResult.approved) {
          rootSpan.setAttributes({ 'payment.outcome': 'risk_rejected' })
          return this.failedResult(request.transactionHash, processedAt, {
            validation: { duration: validationMs, success: true },
            riskCheck:  { duration: riskMs, approved: false, riskScore: riskResult.riskScore },
            processor:  { duration: 0, success: false },
            settlement: { duration: 0, success: false, isDuplicate: false },
          })
        }

        // ── Stage 4: processor ───────────────────────────────────────────
        const processorStart  = Date.now()
        const processorResult = await this.processPayment(request)
        const processorMs     = Date.now() - processorStart

        // ── Stage 5: settle ──────────────────────────────────────────────
        const settleStart                   = Date.now()
        const { settlementId, isDuplicate } = await this.settlePayment(request, processorResult)
        const settleMs                      = Date.now() - settleStart

        rootSpan.setAttributes({
          'payment.settlement_id': settlementId,
          'payment.is_duplicate':  isDuplicate,
          'payment.outcome':       'settled',
        })
        rootSpan.setStatus({ code: SpanStatusCode.OK })

        return {
          settlementId,
          status: 'settled' as const,
          transactionHash: request.transactionHash,
          processedAt,
          stages: {
            validation: { duration: validationMs, success: true },
            riskCheck:  { duration: riskMs,       approved: true, riskScore: riskResult.riskScore },
            processor:  { duration: processorMs,  success: true },
            settlement: { duration: settleMs,     success: true, isDuplicate },
          },
        }
      } catch (error) {
        rootSpan.setStatus({
          code:    SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unexpected orchestrator error',
        })
        rootSpan.recordException(error as Error)
        throw error
      } finally {
        rootSpan.end()
      }
    })
  }

  // ── Private stage implementations ──────────────────────────────────────────

  /**
   * Stage 1 – Ingest: normalize the incoming request and record key fields
   * as span attributes for downstream correlation.
   */
  private async ingestPayment(request: PaymentRequest): Promise<void> {
    return this.tracer.startActiveSpan(PaymentSpans.INGEST, async (span) => {
      try {
        span.setAttributes({
          'ingest.bond_id':          request.bondId,
          'ingest.amount':           request.amount,
          'ingest.transaction_hash': request.transactionHash,
          'ingest.from_account':     request.fromAccount,
        })

        const trimmed = request.amount.trim()
        if (!trimmed) {
          throw new Error('Payment amount must not be empty')
        }

        span.setAttributes({ 'ingest.normalized_amount': trimmed })
        span.setStatus({ code: SpanStatusCode.OK })
      } catch (error) {
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Ingest error',
        })
        span.recordException(error as Error)
        throw error
      } finally {
        span.end()
      }
    })
  }

  /**
   * Stage 2 – Validate: check structural and format integrity of every field.
   * Validation failures return a result object; they do not throw.
   */
  private async validatePayment(request: PaymentRequest): Promise<ValidationResult> {
    return this.tracer.startActiveSpan(PaymentSpans.VALIDATE, async (span) => {
      try {
        const errors: string[] = []

        if (!Number.isInteger(request.bondId) || request.bondId <= 0) {
          errors.push('bondId must be a positive integer')
        }

        try {
          if (BigInt(request.amount) < 0n) {
            errors.push('amount must be non-negative')
          }
        } catch {
          errors.push('amount must be a valid integer string')
        }

        if (!TX_HASH_RE.test(request.transactionHash)) {
          errors.push('transactionHash must be a 64-character hex string')
        }

        const addressValid =
          ETH_ADDR_RE.test(request.fromAccount) || STELLAR_ADDR_RE.test(request.fromAccount)
        if (!addressValid) {
          errors.push('fromAccount must be a valid Ethereum or Stellar address')
        }

        const valid = errors.length === 0

        span.setAttributes({
          'validate.valid':       valid,
          'validate.error_count': errors.length,
        })
        span.setStatus({ code: valid ? SpanStatusCode.OK : SpanStatusCode.ERROR })

        return valid ? { valid: true } : { valid: false, errors }
      } finally {
        span.end()
      }
    })
  }

  /**
   * Stage 3 – Risk check: derive a numeric risk score from the payment amount.
   * Payments exceeding the high-risk threshold are rejected outright.
   */
  private async processRiskCheck(request: PaymentRequest): Promise<RiskCheckResult> {
    return this.tracer.startActiveSpan(PaymentSpans.RISK_CHECK, async (span) => {
      try {
        let riskScore = 0
        let reason: string | undefined

        try {
          const amount = BigInt(request.amount)
          if (amount >= RISK_HIGH_THRESHOLD) {
            riskScore = 90
            reason    = 'amount exceeds high-risk threshold'
          } else if (amount >= RISK_MEDIUM_THRESHOLD) {
            riskScore = 50
          }
        } catch {
          riskScore = 100
          reason    = 'malformed amount string'
        }

        const approved = riskScore < 80

        span.setAttributes({
          'risk.score':    riskScore,
          'risk.approved': approved,
          ...(reason ? { 'risk.rejection_reason': reason } : {}),
        })
        span.setStatus({ code: approved ? SpanStatusCode.OK : SpanStatusCode.ERROR })

        return { approved, riskScore, ...(reason ? { reason } : {}) }
      } finally {
        span.end()
      }
    })
  }

  /**
   * Stage 4 – Processor: submit the payment for on-chain processing.
   * In production this would call Stellar Horizon; here it records the intent.
   */
  private async processPayment(request: PaymentRequest): Promise<ProcessorResult> {
    return this.tracer.startActiveSpan(PaymentSpans.PROCESSOR, async (span) => {
      try {
        span.setAttributes({
          'processor.bond_id':          request.bondId,
          'processor.transaction_hash': request.transactionHash,
        })

        const result: ProcessorResult = {
          success:         true,
          transactionHash: request.transactionHash,
          timestamp:       new Date(),
        }

        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (error) {
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Processor error',
        })
        span.recordException(error as Error)
        throw error
      } finally {
        span.end()
      }
    })
  }

  /**
   * Stage 5 – Settle: persist a settlement record and report whether it was a
   * duplicate (idempotent re-submission of an already-recorded transaction).
   */
  private async settlePayment(
    request: PaymentRequest,
    processorResult: ProcessorResult,
  ): Promise<{ settlementId: number; isDuplicate: boolean }> {
    return this.tracer.startActiveSpan(PaymentSpans.SETTLE, async (span) => {
      try {
        span.setAttributes({
          'settle.bond_id':          request.bondId,
          'settle.transaction_hash': processorResult.transactionHash,
          'settle.amount':           request.amount,
        })

        const { settlement, isDuplicate } = await this.repository.upsert({
          bondId:          request.bondId,
          amount:          request.amount,
          transactionHash: processorResult.transactionHash,
          status:          'settled',
        })

        const settlementId = Number(settlement.id)

        span.setAttributes({
          'settle.settlement_id': settlementId,
          'settle.status':        settlement.status,
          'settle.is_duplicate':  isDuplicate,
        })
        span.setStatus({ code: SpanStatusCode.OK })

        return { settlementId, isDuplicate }
      } catch (error) {
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Settlement error',
        })
        span.recordException(error as Error)
        throw error
      } finally {
        span.end()
      }
    })
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private failedResult(
    transactionHash: string,
    processedAt: Date,
    stages: PaymentResult['stages'],
  ): PaymentResult {
    return {
      settlementId:    0,
      status:          'failed' as const,
      transactionHash,
      processedAt,
      stages,
    }
  }
}
