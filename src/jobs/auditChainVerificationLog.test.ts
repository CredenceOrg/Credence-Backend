/**
 * Tests for logAuditChainVerification
 *
 * This module is a thin integration point between the audit chain verifier and the
 * structured logging / redaction pipeline. The tests below enforce every documented
 * invariant so that a future change to the payload shape, the log schema, or the
 * redaction allowlist cannot silently break observability or leak PII.
 *
 * Invariants under test:
 *  1. logger.info is called exactly once per invocation
 *  2. The payload is always run through redact() with the correct eventType context
 *  3. eventType is NOT present in the logged output (not in the allowlist schema)
 *  4. firstViolationId is NOT present in the logged output (not in schema)
 *  5. violations array is NOT present in the logged output (not in schema)
 *  6. Unknown extra fields are dropped (fail-secure allowlist)
 *  7. PII-named fields are replaced with "[REDACTED]"
 *  8. lastCheckedSeq defaults to 0 when the result omits it
 *  9. firstViolationSeq is omitted from the payload (and output) when undefined
 * 10. firstViolationSeq=0 is a valid value and IS forwarded
 * 11. All numeric fields (rowsChecked, violationCount, lastCheckedSeq) pass through correctly
 * 12. logger.info errors propagate to the caller (no silent swallowing)
 * 13. Concurrent / repeated calls are each independent and each call logs once
 *
 * Boundary & recovery invariants (extended):
 * 14. violationCount and firstViolationSeq accept Number.MAX_SAFE_INTEGER without truncation
 * 15. Multiple consecutive logger failures do not corrupt subsequent successful calls
 * 16. Retry loop: identical payload repeated N times produces identical output each time
 * 17. All four ChainViolation types are fully stripped — none leak into log output
 * 18. The output key set is exactly the schema allowlist — no extra keys, no missing keys
 * 19. Contradictory-but-structurally-valid inputs (valid=false/violationCount=0, valid=true/firstViolationSeq set) are logged as-is without error
 * 20. redact() is called before logger.info() within the same invocation (ordering invariant)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest'
import * as loggerModule from '../utils/logger.js'
import * as redactionModule from '../observability/redaction.js'
import { logAuditChainVerification } from './auditChainVerificationLog.js'
import { LogEventType } from '../observability/logSchemas.js'
import type { ChainVerificationResult, ChainViolation } from '../services/audit/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid ChainVerificationResult.  Individual tests can override
 * fields to exercise specific paths.
 */
function makeResult(overrides: Partial<ChainVerificationResult> = {}): ChainVerificationResult {
  return {
    valid: true,
    rowsChecked: 10,
    violationCount: 0,
    violations: [],
    checkedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Capture the object argument passed to logger.info (the already-redacted payload).
 * logger.info receives the return value of redact(), which is a plain object.
 */
function captureLoggedPayload(spy: MockInstance): Record<string, unknown> {
  expect(spy).toHaveBeenCalledOnce()
  const arg = spy.mock.calls[0][0]
  return arg as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Fixture setup: spy on logger.info and optionally on redact()
// ---------------------------------------------------------------------------

describe('logAuditChainVerification', () => {
  let loggerInfoSpy: MockInstance

  beforeEach(() => {
    loggerInfoSpy = vi.spyOn(loggerModule.logger, 'info')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Happy-path: valid chain
  // -------------------------------------------------------------------------

  describe('happy path — valid chain', () => {
    it('calls logger.info exactly once', () => {
      logAuditChainVerification(makeResult())
      expect(loggerInfoSpy).toHaveBeenCalledOnce()
    })

    it('passes the redacted payload as the first argument to logger.info', () => {
      logAuditChainVerification(makeResult({ valid: true, rowsChecked: 5, violationCount: 0 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(typeof payload).toBe('object')
      expect(payload).not.toBeNull()
    })

    it('emits valid=true for a clean run', () => {
      logAuditChainVerification(makeResult({ valid: true }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(true)
    })

    it('emits rowsChecked correctly', () => {
      logAuditChainVerification(makeResult({ rowsChecked: 42 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(42)
    })

    it('emits violationCount=0 for a clean run', () => {
      logAuditChainVerification(makeResult({ violationCount: 0 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.violationCount).toBe(0)
    })

    it('emits checkedAt as-is', () => {
      const ts = '2025-06-15T12:34:56.789Z'
      logAuditChainVerification(makeResult({ checkedAt: ts }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.checkedAt).toBe(ts)
    })
  })

  // -------------------------------------------------------------------------
  // Happy-path: invalid chain (violations detected)
  // -------------------------------------------------------------------------

  describe('happy path — invalid chain (violations present)', () => {
    it('emits valid=false when violations are found', () => {
      logAuditChainVerification(
        makeResult({ valid: false, violationCount: 3, firstViolationSeq: 5 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(false)
    })

    it('emits violationCount when violations exist', () => {
      logAuditChainVerification(
        makeResult({ valid: false, violationCount: 7, firstViolationSeq: 2 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.violationCount).toBe(7)
    })

    it('emits firstViolationSeq when defined', () => {
      logAuditChainVerification(
        makeResult({ valid: false, violationCount: 1, firstViolationSeq: 9 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.firstViolationSeq).toBe(9)
    })
  })

  // -------------------------------------------------------------------------
  // Default value: lastCheckedSeq
  // -------------------------------------------------------------------------

  describe('lastCheckedSeq default value', () => {
    it('defaults to 0 when lastCheckedSeq is undefined', () => {
      const result = makeResult()
      // Ensure the field is absent from the result object
      delete (result as Partial<ChainVerificationResult>).lastCheckedSeq
      logAuditChainVerification(result)
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.lastCheckedSeq).toBe(0)
    })

    it('emits 0 when lastCheckedSeq is explicitly 0', () => {
      logAuditChainVerification(makeResult({ lastCheckedSeq: 0 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.lastCheckedSeq).toBe(0)
    })

    it('emits the actual value when lastCheckedSeq is positive', () => {
      logAuditChainVerification(makeResult({ lastCheckedSeq: 99 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.lastCheckedSeq).toBe(99)
    })
  })

  // -------------------------------------------------------------------------
  // Optional field: firstViolationSeq
  // -------------------------------------------------------------------------

  describe('firstViolationSeq optional field', () => {
    it('does NOT include firstViolationSeq when undefined (valid run)', () => {
      const result = makeResult({ valid: true, violationCount: 0 })
      // Confirm field is absent
      expect(result.firstViolationSeq).toBeUndefined()
      logAuditChainVerification(result)
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, 'firstViolationSeq')).toBe(false)
    })

    it('includes firstViolationSeq when it is 0 (valid edge value)', () => {
      // seq=0 is unusual but the schema allows it; the conditional check is
      // `!== undefined`, so 0 must NOT be treated as falsy and omitted.
      logAuditChainVerification(makeResult({ firstViolationSeq: 0 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.firstViolationSeq).toBe(0)
    })

    it('includes firstViolationSeq when set to a positive integer', () => {
      logAuditChainVerification(makeResult({ valid: false, violationCount: 2, firstViolationSeq: 17 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.firstViolationSeq).toBe(17)
    })
  })

  // -------------------------------------------------------------------------
  // Security / redaction invariants
  // -------------------------------------------------------------------------

  describe('security — redaction invariants', () => {
    it('eventType is NOT present in the logged payload (not in allowlist schema)', () => {
      // eventType is added to the payload before calling redact(), but the
      // AUDIT_CHAIN_VERIFICATION schema does not include it, so redact() must drop it.
      logAuditChainVerification(makeResult())
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, 'eventType')).toBe(false)
    })

    it('firstViolationId is NOT present in the logged payload (not in schema)', () => {
      logAuditChainVerification(
        makeResult({ valid: false, violationCount: 1, firstViolationSeq: 3, firstViolationId: 'entry-abc' }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, 'firstViolationId')).toBe(false)
    })

    it('violations array is NOT present in the logged payload (not in schema)', () => {
      logAuditChainVerification(
        makeResult({
          valid: false,
          violationCount: 1,
          firstViolationSeq: 1,
          violations: [
            {
              seq: 1,
              id: 'v1',
              expectedPrevHash: null,
              actualPrevHash: 'bad',
              expectedRowHash: 'x',
              actualRowHash: 'y',
              type: 'row_hash_mismatch',
            },
          ],
        }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, 'violations')).toBe(false)
    })

    it('passes payload through redact() with AUDIT_CHAIN_VERIFICATION event type context', () => {
      const redactSpy = vi.spyOn(redactionModule, 'redact')
      logAuditChainVerification(makeResult())

      expect(redactSpy).toHaveBeenCalledOnce()
      const [, context] = redactSpy.mock.calls[0]
      expect(context).toMatchObject({ eventType: LogEventType.AUDIT_CHAIN_VERIFICATION })
    })

    it('redact() receives the correct fields in the payload before filtering', () => {
      const redactSpy = vi.spyOn(redactionModule, 'redact')
      logAuditChainVerification(
        makeResult({ valid: false, rowsChecked: 5, violationCount: 2, lastCheckedSeq: 5, firstViolationSeq: 3 }),
      )

      const [payloadArg] = redactSpy.mock.calls[0]
      expect(payloadArg).toMatchObject({
        eventType: LogEventType.AUDIT_CHAIN_VERIFICATION,
        valid: false,
        rowsChecked: 5,
        violationCount: 2,
        lastCheckedSeq: 5,
        firstViolationSeq: 3,
      })
    })

    it('unknown extra fields on the result are silently dropped by redact()', () => {
      // Cast to any to inject an extra field that is not part of the type
      const result = makeResult() as any
      result.__injected = 'should-be-dropped'
      logAuditChainVerification(result as ChainVerificationResult)
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, '__injected')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Boundary values
  // -------------------------------------------------------------------------

  describe('boundary values', () => {
    it('handles rowsChecked=0 (empty table / never run)', () => {
      logAuditChainVerification(makeResult({ rowsChecked: 0 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(0)
    })

    it('handles rowsChecked=1 (single row)', () => {
      logAuditChainVerification(makeResult({ rowsChecked: 1 }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(1)
    })

    it('handles rowsChecked=Number.MAX_SAFE_INTEGER', () => {
      logAuditChainVerification(makeResult({ rowsChecked: Number.MAX_SAFE_INTEGER }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('handles violationCount=0 (valid chain)', () => {
      logAuditChainVerification(makeResult({ violationCount: 0, valid: true }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.violationCount).toBe(0)
    })

    it('handles violationCount=100 (max violations cap)', () => {
      logAuditChainVerification(
        makeResult({ violationCount: 100, valid: false, firstViolationSeq: 1 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.violationCount).toBe(100)
    })

    it('handles an empty violations array without error', () => {
      expect(() => logAuditChainVerification(makeResult({ violations: [] }))).not.toThrow()
    })

    it('handles a large violations array without error', () => {
      const manyViolations = Array.from({ length: 500 }, (_, i) => ({
        seq: i + 1,
        id: `entry-${i + 1}`,
        expectedPrevHash: null,
        actualPrevHash: 'wrong',
        expectedRowHash: 'x',
        actualRowHash: 'y',
        type: 'row_hash_mismatch' as const,
      }))
      expect(() =>
        logAuditChainVerification(makeResult({ violations: manyViolations, violationCount: 500 })),
      ).not.toThrow()
      // violations must still be absent from the output
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(Object.prototype.hasOwnProperty.call(payload, 'violations')).toBe(false)
    })

    it('handles checkedAt with a millisecond-precision ISO timestamp', () => {
      const ts = '2025-12-31T23:59:59.999Z'
      logAuditChainVerification(makeResult({ checkedAt: ts }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.checkedAt).toBe(ts)
    })

    it('handles checkedAt with a second-precision ISO timestamp', () => {
      const ts = '2025-01-01T00:00:00Z'
      logAuditChainVerification(makeResult({ checkedAt: ts }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.checkedAt).toBe(ts)
    })

    it('lastCheckedSeq=Number.MAX_SAFE_INTEGER passes through', () => {
      logAuditChainVerification(makeResult({ lastCheckedSeq: Number.MAX_SAFE_INTEGER }))
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.lastCheckedSeq).toBe(Number.MAX_SAFE_INTEGER)
    })
  })

  // -------------------------------------------------------------------------
  // Concurrency / idempotency — pure function, no shared mutable state
  // -------------------------------------------------------------------------

  describe('concurrency and repeated calls', () => {
    it('each of N sequential calls invokes logger.info exactly once', () => {
      const calls = 5
      for (let i = 0; i < calls; i++) {
        logAuditChainVerification(makeResult({ rowsChecked: i }))
      }
      expect(loggerInfoSpy).toHaveBeenCalledTimes(calls)
    })

    it('each call is independent — the Nth call emits the Nth result', () => {
      const results = [
        makeResult({ rowsChecked: 10, valid: true }),
        makeResult({ rowsChecked: 20, valid: false, violationCount: 1, firstViolationSeq: 15 }),
      ]

      for (const r of results) {
        logAuditChainVerification(r)
      }

      // First call
      const first = loggerInfoSpy.mock.calls[0][0] as Record<string, unknown>
      expect(first.rowsChecked).toBe(10)
      expect(first.valid).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(first, 'firstViolationSeq')).toBe(false)

      // Second call
      const second = loggerInfoSpy.mock.calls[1][0] as Record<string, unknown>
      expect(second.rowsChecked).toBe(20)
      expect(second.valid).toBe(false)
      expect(second.firstViolationSeq).toBe(15)
    })

    it('concurrent calls (Promise.all) are each independent and log once each', async () => {
      const count = 10
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          Promise.resolve(logAuditChainVerification(makeResult({ rowsChecked: i }))),
        ),
      )
      expect(loggerInfoSpy).toHaveBeenCalledTimes(count)
    })

    it('second call is not affected by a mutated result from the first call', () => {
      const result = makeResult({ rowsChecked: 5 })
      logAuditChainVerification(result)

      // Mutate result after first call
      result.rowsChecked = 999

      logAuditChainVerification(result)

      const first = loggerInfoSpy.mock.calls[0][0] as Record<string, unknown>
      const second = loggerInfoSpy.mock.calls[1][0] as Record<string, unknown>

      // The first call captured the original value at call time
      expect(first.rowsChecked).toBe(5)
      // The second call uses the mutated value
      expect(second.rowsChecked).toBe(999)
    })
  })

  // -------------------------------------------------------------------------
  // Failure / error recovery
  // -------------------------------------------------------------------------

  describe('failure and error propagation', () => {
    it('propagates an error thrown by logger.info to the caller', () => {
      const boom = new Error('logger exploded')
      loggerInfoSpy.mockImplementationOnce(() => {
        throw boom
      })

      expect(() => logAuditChainVerification(makeResult())).toThrow('logger exploded')
    })

    it('propagates an error thrown by redact() to the caller', () => {
      const redactSpy = vi.spyOn(redactionModule, 'redact').mockImplementationOnce(() => {
        throw new Error('redact failed')
      })

      expect(() => logAuditChainVerification(makeResult())).toThrow('redact failed')
      redactSpy.mockRestore()
    })

    it('does NOT swallow errors — no try/catch in the implementation', () => {
      // After a throwing call, the spy call count must still reflect the attempt
      loggerInfoSpy.mockImplementationOnce(() => {
        throw new Error('fail')
      })

      expect(() => logAuditChainVerification(makeResult())).toThrow()
      expect(loggerInfoSpy).toHaveBeenCalledOnce()
    })

    it('is callable again after a prior call threw', () => {
      loggerInfoSpy
        .mockImplementationOnce(() => {
          throw new Error('transient failure')
        })
        .mockImplementationOnce(() => undefined)

      // First call throws
      expect(() => logAuditChainVerification(makeResult())).toThrow('transient failure')
      // Second call succeeds
      expect(() => logAuditChainVerification(makeResult())).not.toThrow()
      expect(loggerInfoSpy).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Minimal required fields
  // -------------------------------------------------------------------------

  describe('minimal input', () => {
    it('logs successfully with only required fields and no optional fields', () => {
      const minimal: ChainVerificationResult = {
        valid: true,
        rowsChecked: 0,
        violationCount: 0,
        violations: [],
        checkedAt: '2025-01-01T00:00:00.000Z',
        // lastCheckedSeq, firstViolationSeq, firstViolationId intentionally omitted
      }

      expect(() => logAuditChainVerification(minimal)).not.toThrow()
      expect(loggerInfoSpy).toHaveBeenCalledOnce()

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(true)
      expect(payload.rowsChecked).toBe(0)
      expect(payload.violationCount).toBe(0)
      expect(payload.lastCheckedSeq).toBe(0) // default applied
      expect(Object.prototype.hasOwnProperty.call(payload, 'firstViolationSeq')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Integration: full round-trip through real redact()
  // -------------------------------------------------------------------------

  describe('integration — real redact() pipeline', () => {
    it('produces a valid-chain payload with all expected fields and no extras', () => {
      const ts = '2025-03-10T08:00:00.000Z'
      logAuditChainVerification(
        makeResult({
          valid: true,
          rowsChecked: 1000,
          violationCount: 0,
          lastCheckedSeq: 1000,
          checkedAt: ts,
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)

      // Required schema fields present
      expect(payload.valid).toBe(true)
      expect(payload.rowsChecked).toBe(1000)
      expect(payload.violationCount).toBe(0)
      expect(payload.lastCheckedSeq).toBe(1000)
      expect(payload.checkedAt).toBe(ts)

      // Fields that must NOT appear
      expect(payload).not.toHaveProperty('eventType')
      expect(payload).not.toHaveProperty('firstViolationId')
      expect(payload).not.toHaveProperty('violations')
      expect(payload).not.toHaveProperty('firstViolationSeq')
    })

    it('produces a violation-run payload including firstViolationSeq but not violations', () => {
      const ts = '2025-03-10T09:00:00.000Z'
      logAuditChainVerification(
        makeResult({
          valid: false,
          rowsChecked: 50,
          violationCount: 3,
          lastCheckedSeq: 50,
          firstViolationSeq: 12,
          firstViolationId: 'entry-12',
          checkedAt: ts,
          violations: [
            {
              seq: 12,
              id: 'entry-12',
              expectedPrevHash: 'abc',
              actualPrevHash: 'xyz',
              expectedRowHash: '123',
              actualRowHash: '456',
              type: 'prev_hash_mismatch',
            },
          ],
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)

      expect(payload.valid).toBe(false)
      expect(payload.rowsChecked).toBe(50)
      expect(payload.violationCount).toBe(3)
      expect(payload.lastCheckedSeq).toBe(50)
      expect(payload.firstViolationSeq).toBe(12)
      expect(payload.checkedAt).toBe(ts)

      // Must be absent from output
      expect(payload).not.toHaveProperty('eventType')
      expect(payload).not.toHaveProperty('firstViolationId')
      expect(payload).not.toHaveProperty('violations')
    })

    it('never-run scenario: rowsChecked=0, lastCheckedSeq=0, violationCount=0', () => {
      logAuditChainVerification(
        makeResult({
          valid: true,
          rowsChecked: 0,
          violationCount: 0,
          checkedAt: '2025-01-01T00:00:00.000Z',
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(true)
      expect(payload.rowsChecked).toBe(0)
      expect(payload.violationCount).toBe(0)
      expect(payload.lastCheckedSeq).toBe(0)
      expect(payload).not.toHaveProperty('firstViolationSeq')
    })
  })

  // -------------------------------------------------------------------------
  // Boundary values — extended numeric extremes (invariant 14)
  // -------------------------------------------------------------------------

  describe('boundary values — extended numeric extremes', () => {
    /**
     * Invariant 14a: violationCount accepts Number.MAX_SAFE_INTEGER without truncation.
     * The schema declares violationCount as { type: "number" } with no upper bound,
     * so even a pathologically large value must pass through unmodified.
     */
    it('violationCount=Number.MAX_SAFE_INTEGER passes through without truncation', () => {
      logAuditChainVerification(
        makeResult({
          valid: false,
          violationCount: Number.MAX_SAFE_INTEGER,
          firstViolationSeq: 1,
        }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.violationCount).toBe(Number.MAX_SAFE_INTEGER)
    })

    /**
     * Invariant 14b: firstViolationSeq accepts Number.MAX_SAFE_INTEGER.
     * Ensures the optional-field conditional (`!== undefined`) does not interfere
     * with extreme numeric values.
     */
    it('firstViolationSeq=Number.MAX_SAFE_INTEGER passes through without truncation', () => {
      logAuditChainVerification(
        makeResult({
          valid: false,
          violationCount: 1,
          firstViolationSeq: Number.MAX_SAFE_INTEGER,
        }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.firstViolationSeq).toBe(Number.MAX_SAFE_INTEGER)
    })

    /**
     * Invariant 14c: rowsChecked one below MAX_SAFE_INTEGER — near-boundary value
     * to confirm there is no off-by-one at the upper edge of JS integer precision.
     */
    it('rowsChecked=Number.MAX_SAFE_INTEGER - 1 passes through without truncation', () => {
      logAuditChainVerification(
        makeResult({ rowsChecked: Number.MAX_SAFE_INTEGER - 1 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(Number.MAX_SAFE_INTEGER - 1)
    })

    /**
     * Invariant 14d: lastCheckedSeq one below MAX_SAFE_INTEGER — near-boundary.
     */
    it('lastCheckedSeq=Number.MAX_SAFE_INTEGER - 1 passes through without truncation', () => {
      logAuditChainVerification(
        makeResult({ lastCheckedSeq: Number.MAX_SAFE_INTEGER - 1 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.lastCheckedSeq).toBe(Number.MAX_SAFE_INTEGER - 1)
    })

    /**
     * Invariant 14e: violationCount=1 (minimum detectable violation count).
     * Validates the boundary between "valid" and "first violation detected" states.
     */
    it('violationCount=1 is the minimum detectable violation and emits correctly', () => {
      logAuditChainVerification(
        makeResult({ valid: false, violationCount: 1, firstViolationSeq: 1 }),
      )
      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(false)
      expect(payload.violationCount).toBe(1)
      expect(payload.firstViolationSeq).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Recovery — multiple consecutive failures then success (invariant 15)
  // -------------------------------------------------------------------------

  describe('recovery — multiple consecutive logger failures', () => {
    /**
     * Invariant 15a: After N consecutive logger.info failures, the (N+1)th call
     * succeeds and emits the correct payload. No state bleeds between calls.
     */
    it('recovers correctly after 3 consecutive logger failures', () => {
      const boom = new Error('transient logger failure')

      // First 3 calls throw
      loggerInfoSpy
        .mockImplementationOnce(() => { throw boom })
        .mockImplementationOnce(() => { throw boom })
        .mockImplementationOnce(() => { throw boom })
        .mockImplementationOnce(() => undefined) // 4th call succeeds

      for (let i = 0; i < 3; i++) {
        expect(() => logAuditChainVerification(makeResult({ rowsChecked: i }))).toThrow('transient logger failure')
      }

      // 4th call must succeed and emit the correct payload
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 42 }))).not.toThrow()
      expect(loggerInfoSpy).toHaveBeenCalledTimes(4)

      const successPayload = loggerInfoSpy.mock.calls[3][0] as Record<string, unknown>
      expect(successPayload.rowsChecked).toBe(42)
    })

    /**
     * Invariant 15b: A failure in redact() on one call does not affect the next call.
     * Each invocation is fully isolated — no shared mutable state between calls.
     */
    it('recovers correctly after redact() fails on one call', () => {
      const redactSpy = vi.spyOn(redactionModule, 'redact')

      redactSpy.mockImplementationOnce(() => {
        throw new Error('redact transient failure')
      })

      // First call: redact throws
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 1 }))).toThrow('redact transient failure')

      // Second call: redact succeeds normally
      redactSpy.mockRestore()
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 99 }))).not.toThrow()

      const successPayload = loggerInfoSpy.mock.calls[0][0] as Record<string, unknown>
      expect(successPayload.rowsChecked).toBe(99)
    })

    /**
     * Invariant 15c: After interleaved failures and successes, each successful call
     * emits exactly the data from that specific invocation — no data from a failed
     * preceding call can "leak" into a later successful one.
     */
    it('interleaved failures and successes emit independent correct payloads', () => {
      loggerInfoSpy
        .mockImplementationOnce(() => { throw new Error('fail') }) // call 1 fails
        .mockImplementationOnce(() => undefined)                   // call 2 succeeds
        .mockImplementationOnce(() => { throw new Error('fail') }) // call 3 fails
        .mockImplementationOnce(() => undefined)                   // call 4 succeeds

      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 10 }))).toThrow()
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 20 }))).not.toThrow()
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 30 }))).toThrow()
      expect(() => logAuditChainVerification(makeResult({ rowsChecked: 40 }))).not.toThrow()

      // Only calls 2 and 4 produced logged output
      expect(loggerInfoSpy).toHaveBeenCalledTimes(4) // called 4 times total
      const second = loggerInfoSpy.mock.calls[1][0] as Record<string, unknown>
      const fourth = loggerInfoSpy.mock.calls[3][0] as Record<string, unknown>
      expect(second.rowsChecked).toBe(20)
      expect(fourth.rowsChecked).toBe(40)
    })
  })

  // -------------------------------------------------------------------------
  // Retry loop idempotency (invariant 16)
  // -------------------------------------------------------------------------

  describe('retry loop idempotency', () => {
    /**
     * Invariant 16a: Identical input replayed N times (simulating retry logic)
     * produces identical output payloads each time. The function is pure and
     * free of side-effects that could alter output across retries.
     */
    it('produces identical output for N retries of the same payload', () => {
      const retryCount = 5
      const input = makeResult({
        valid: false,
        rowsChecked: 77,
        violationCount: 2,
        lastCheckedSeq: 77,
        firstViolationSeq: 42,
        checkedAt: '2025-06-01T12:00:00.000Z',
      })

      for (let i = 0; i < retryCount; i++) {
        logAuditChainVerification(input)
      }

      expect(loggerInfoSpy).toHaveBeenCalledTimes(retryCount)

      // All payloads must be structurally identical
      const payloads = loggerInfoSpy.mock.calls.map((call) => call[0] as Record<string, unknown>)
      const reference = payloads[0]

      for (const payload of payloads.slice(1)) {
        expect(payload).toEqual(reference)
      }
    })

    /**
     * Invariant 16b: A retry after a transient failure produces the same output
     * as a first-attempt success — idempotent regardless of attempt number.
     */
    it('retry after transient failure produces the same output as a fresh call', () => {
      const boom = new Error('transient')

      loggerInfoSpy
        .mockImplementationOnce(() => { throw boom })
        .mockImplementationOnce(() => undefined)

      const input = makeResult({ rowsChecked: 55, valid: true })

      // First attempt fails
      expect(() => logAuditChainVerification(input)).toThrow('transient')

      // Retry (same payload) succeeds
      expect(() => logAuditChainVerification(input)).not.toThrow()

      // The successful call's payload must match what a direct call would produce
      const retryPayload = loggerInfoSpy.mock.calls[1][0] as Record<string, unknown>
      expect(retryPayload.rowsChecked).toBe(55)
      expect(retryPayload.valid).toBe(true)
      expect(retryPayload.violationCount).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // All ChainViolation types are fully stripped (invariant 17)
  // -------------------------------------------------------------------------

  describe('all four ChainViolation types are stripped from log output', () => {
    /**
     * Invariant 17: The violations array may contain records of four distinct
     * types: 'prev_hash_mismatch', 'row_hash_mismatch', 'missing_row', 'deleted_row'.
     * Regardless of which types are present, the entire violations array must
     * never appear in the log output. This prevents raw chain forensic data
     * from leaking into the log stream.
     */
    const allViolationTypes: Array<ChainViolation['type']> = [
      'prev_hash_mismatch',
      'row_hash_mismatch',
      'missing_row',
      'deleted_row',
    ]

    for (const violationType of allViolationTypes) {
      it(`violations with type '${violationType}' are completely stripped from log output`, () => {
        logAuditChainVerification(
          makeResult({
            valid: false,
            violationCount: 1,
            firstViolationSeq: 3,
            violations: [
              {
                seq: 3,
                id: 'entry-003',
                expectedPrevHash: 'abc123',
                actualPrevHash: 'xyz789',
                expectedRowHash: 'expected-hash',
                actualRowHash: 'actual-hash',
                type: violationType,
              },
            ],
          }),
        )

        const payload = captureLoggedPayload(loggerInfoSpy)
        expect(Object.prototype.hasOwnProperty.call(payload, 'violations')).toBe(false)
        // Also confirm firstViolationId (which the verifier sets) is stripped
        expect(Object.prototype.hasOwnProperty.call(payload, 'firstViolationId')).toBe(false)
        // But firstViolationSeq (which IS in the schema) must be present
        expect(payload.firstViolationSeq).toBe(3)
      })
    }

    it('violations array with all four types simultaneously produces no violations key in output', () => {
      logAuditChainVerification(
        makeResult({
          valid: false,
          violationCount: 4,
          firstViolationSeq: 1,
          violations: allViolationTypes.map((type, i) => ({
            seq: i + 1,
            id: `entry-${String(i + 1).padStart(3, '0')}`,
            expectedPrevHash: i === 0 ? null : `prev-hash-${i}`,
            actualPrevHash: `actual-prev-${i}`,
            expectedRowHash: `expected-row-${i}`,
            actualRowHash: `actual-row-${i}`,
            type,
          })),
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload).not.toHaveProperty('violations')
      expect(payload).not.toHaveProperty('firstViolationId')
      expect(payload.violationCount).toBe(4)
      expect(payload.firstViolationSeq).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Schema allowlist completeness — exact output key set (invariant 18)
  // -------------------------------------------------------------------------

  describe('schema allowlist completeness — exact output key set', () => {
    /**
     * Invariant 18a: For a valid chain (no firstViolationSeq), the output
     * must contain exactly these keys and no others:
     *   valid, rowsChecked, violationCount, lastCheckedSeq, checkedAt
     *
     * This test guards against schema drift where a new field gets added to
     * AUDIT_CHAIN_VERIFICATION without a corresponding review.
     */
    it('valid-chain output contains exactly the expected schema keys', () => {
      logAuditChainVerification(
        makeResult({
          valid: true,
          rowsChecked: 10,
          violationCount: 0,
          lastCheckedSeq: 10,
          checkedAt: '2025-07-01T00:00:00.000Z',
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)
      const keys = Object.keys(payload).sort()

      // Exactly these keys — no more, no less
      expect(keys).toEqual(['checkedAt', 'lastCheckedSeq', 'rowsChecked', 'valid', 'violationCount'])
    })

    /**
     * Invariant 18b: For a violation run (firstViolationSeq present), the output
     * must contain exactly:
     *   valid, rowsChecked, violationCount, lastCheckedSeq, firstViolationSeq, checkedAt
     */
    it('violation-run output contains exactly the expected schema keys including firstViolationSeq', () => {
      logAuditChainVerification(
        makeResult({
          valid: false,
          rowsChecked: 25,
          violationCount: 2,
          lastCheckedSeq: 25,
          firstViolationSeq: 8,
          checkedAt: '2025-07-01T01:00:00.000Z',
        }),
      )

      const payload = captureLoggedPayload(loggerInfoSpy)
      const keys = Object.keys(payload).sort()

      expect(keys).toEqual([
        'checkedAt',
        'firstViolationSeq',
        'lastCheckedSeq',
        'rowsChecked',
        'valid',
        'violationCount',
      ])
    })

    /**
     * Invariant 18c: Injecting a PII-named field alongside a valid payload
     * results in [REDACTED] for that field — but only if it were in the schema.
     * Since PII fields are not in the AUDIT_CHAIN_VERIFICATION schema, they
     * must be dropped entirely (fail-secure), not replaced with [REDACTED].
     */
    it('PII-named field not in schema is dropped entirely (not [REDACTED])', () => {
      const result = makeResult() as any
      // 'email' is a PII field but NOT in AUDIT_CHAIN_VERIFICATION schema
      result.email = 'user@example.com'
      logAuditChainVerification(result as ChainVerificationResult)

      const payload = captureLoggedPayload(loggerInfoSpy)
      // Must not be present at all — the allowlist drops it before PII redaction
      expect(Object.prototype.hasOwnProperty.call(payload, 'email')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Contradictory-but-structurally-valid inputs (invariant 19)
  // -------------------------------------------------------------------------

  describe('contradictory-but-structurally-valid inputs', () => {
    /**
     * Invariant 19a: valid=false with violationCount=0 is logically contradictory
     * but not a type error. The function must not throw; it must log the data as-is.
     * Callers bear responsibility for semantic consistency.
     */
    it('valid=false with violationCount=0 does not throw and logs both values', () => {
      expect(() =>
        logAuditChainVerification(makeResult({ valid: false, violationCount: 0 })),
      ).not.toThrow()

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(false)
      expect(payload.violationCount).toBe(0)
    })

    /**
     * Invariant 19b: valid=true with firstViolationSeq set is also logically contradictory
     * (a valid chain should have no first-violation sequence). The function must log
     * both values faithfully without suppressing either.
     */
    it('valid=true with firstViolationSeq set does not throw and logs both values', () => {
      expect(() =>
        logAuditChainVerification(makeResult({ valid: true, firstViolationSeq: 7 })),
      ).not.toThrow()

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.valid).toBe(true)
      expect(payload.firstViolationSeq).toBe(7)
    })

    /**
     * Invariant 19c: rowsChecked=0 with a non-zero lastCheckedSeq is contradictory
     * (cannot have checked a sequence position without having examined any rows).
     * Must log faithfully without error.
     */
    it('rowsChecked=0 with lastCheckedSeq=500 does not throw and logs both values', () => {
      expect(() =>
        logAuditChainVerification(makeResult({ rowsChecked: 0, lastCheckedSeq: 500 })),
      ).not.toThrow()

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(0)
      expect(payload.lastCheckedSeq).toBe(500)
    })

    /**
     * Invariant 19d: violationCount greater than rowsChecked is structurally impossible
     * but must not cause a crash — the logger faithfully records what it receives.
     */
    it('violationCount > rowsChecked does not throw and logs both values faithfully', () => {
      expect(() =>
        logAuditChainVerification(
          makeResult({ rowsChecked: 5, violationCount: 100, valid: false }),
        ),
      ).not.toThrow()

      const payload = captureLoggedPayload(loggerInfoSpy)
      expect(payload.rowsChecked).toBe(5)
      expect(payload.violationCount).toBe(100)
    })
  })

  // -------------------------------------------------------------------------
  // Call ordering: redact() before logger.info() (invariant 20)
  // -------------------------------------------------------------------------

  describe('call ordering — redact() precedes logger.info()', () => {
    /**
     * Invariant 20: redact() MUST be called before logger.info() within the same
     * invocation. The argument passed to logger.info must be the return value of
     * redact(), not the raw payload. This ordering is the security guarantee that
     * prevents raw (un-redacted) payloads from hitting the log transport.
     *
     * We verify this by tracking call order via a shared sequence counter.
     */
    it('redact() is called before logger.info() within the same invocation', () => {
      const callOrder: string[] = []

      const redactSpy = vi.spyOn(redactionModule, 'redact').mockImplementation(
        (obj: any, ctx: any) => {
          callOrder.push('redact')
          // Return a sentinel so we can confirm logger.info received redact's output
          return { __redactedSentinel: true, ...obj, eventType: undefined }
        },
      )

      loggerInfoSpy.mockImplementation((arg: any) => {
        callOrder.push('logger.info')
      })

      logAuditChainVerification(makeResult())

      // redact must appear before logger.info in the call sequence
      expect(callOrder).toEqual(['redact', 'logger.info'])

      redactSpy.mockRestore()
    })

    /**
     * Invariant 20b: logger.info receives the direct return value of redact().
     * If redact() returns a specific object, that exact object (by reference) must
     * be what logger.info receives — the implementation must not wrap or re-process
     * the redact output before forwarding it.
     */
    it('logger.info receives the exact return value of redact()', () => {
      const redactedOutput = { valid: true, rowsChecked: 5, __marker: 'from-redact' }

      const redactSpy = vi.spyOn(redactionModule, 'redact').mockReturnValueOnce(redactedOutput)

      logAuditChainVerification(makeResult())

      // logger.info must have been called with the exact object returned by redact()
      expect(loggerInfoSpy).toHaveBeenCalledOnce()
      expect(loggerInfoSpy).toHaveBeenCalledWith(redactedOutput)

      redactSpy.mockRestore()
    })
  })
})
