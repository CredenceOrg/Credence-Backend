import { auditLogService } from '../services/audit/index.js'
import { logAuditChainVerification } from './auditChainVerificationLog.js'
import type { AuditChainVerificationHooks } from './auditChainVerifier.js'

export interface AuditChainVerificationHookOptions {
  /**
   * Maximum number of attempts for persisting a verification result.
   * Must be a positive integer. Defaults to 3.
   */
  maxSaveAttempts?: number
  /**
   * Base delay in milliseconds between save retries. Must be non-negative.
   * Defaults to 250.
   */
  retryBaseDelayMs?: number
  /**
   * Optional hook invoked when a save attempt fails. Receives the error and
   * the 1-indexed attempt number that just failed. Must not throw.
   */
  onSaveFailure??: (error: unknown, attempt: number) => void
  /**
   * Optional hook invoked after all save attempts have been exhausted.
   * Receives the last error. Must not throw.
   */
  onSaveExhausted?: (error: unknown) => void
}

function normalizePositiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeInvoke(fn: (() => void) | undefined): void {
  if (!fn) return
  try {
    fn()
  } catch {
    // Observability hooks must never break the verification flow.
  }
}

/**
 * Default persistence and structured logging hooks for scheduled verification runs.
 *
 * Invariants:
 * - `saveStatus` is deterministic and idempotent from the caller's perspective:
 *   it retries transient failures with bounded exponential backoff and only
 *   rejects after all attempts are exhausted.
 * - `logVerification` is fire-and-forget and must never throw into the caller;
 *   failures are swallowed and reported through the optional observability hooks.
 * - No sensitive data is included in error messages or logs.
 */
export function createDefaultAuditChainVerificationHooks(
  options: AuditChainVerificationHookOptions = {},
): AuditChainVerificationHooks {
  const maxSaveAttempts = normalizePositiveInt(
    options.maxSaveAttempts,
    3,
    'maxSaveAttempts',
  )
  const retryBaseDelayMs = normalizeNonNegativeNumber(
    options.retryBaseDelayMs,
    250,
    'retryBaseDelayMs',
  )

  return {
    saveStatus: async (result) => {
      let lastError: unknown
      for (let attempt = 1; attempt <= maxSaveAttempts; attempt++) {
        try {
          await auditLogService.saveChainVerificationStatus(result)
          return
        } catch (error) {
          lastError = error
          safeInvoke(() => options.onSaveFailure?.(error, attempt))
          if (attempt < maxSaveAttempts) {
            const delay = retryBaseDelayMs * 2 ** (attempt - 1)
            await sleep(delay)
          }
        }
      }
      safeInvoke(() => options.onSaveExhausted?.(lastError))
      throw lastError
    },
    logVerification: (result) => {
      try {
        logAuditChainVerification(result)
      } catch {
        // Logging must not fail the verification run.
      }
    },
  }
}
