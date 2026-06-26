import { ZodType, ZodError, ZodIssue, z } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'

// ── Reason codes ──────────────────────────────────────────────────────────────

/**
 * Standardised reason codes attached to every DLQ entry.
 *
 * Using a string enum ensures codes survive JSON serialisation and are
 * human-readable when browsing the `failed_inbound_events` table.
 */
export enum DlqReasonCode {
  /** The inbound payload did not match the expected Zod schema. */
  SCHEMA_VALIDATION_FAILED = 'SCHEMA_VALIDATION_FAILED',
  /** The message type is not recognised by any registered handler. */
  UNKNOWN_MESSAGE_TYPE = 'UNKNOWN_MESSAGE_TYPE',
  /** The payload passed schema validation but processing threw an error. */
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  /** The message has exceeded the configured maximum retry attempts. */
  MAX_RETRIES_EXCEEDED = 'MAX_RETRIES_EXCEEDED',
}

// ── Validation result ─────────────────────────────────────────────────────────

/** A payload that parsed and typed successfully. */
export interface ValidationSuccess<T> {
  valid: true
  data: T
}

/** A payload that failed schema validation or is otherwise poisoned. */
export interface ValidationFailure {
  valid: false
  reasonCode: DlqReasonCode
  /** Human-readable description of every failing field. */
  detail: string
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

// ── Core validation ───────────────────────────────────────────────────────────

/**
 * Run a Zod schema against an unknown runtime value.
 *
 * Returns a typed `ValidationSuccess` when parsing succeeds, or a
 * `ValidationFailure` with `SCHEMA_VALIDATION_FAILED` and a semicolon-separated
 * list of field-level errors when it does not.  Never throws.
 *
 * @example
 * ```ts
 * const result = validateMessage(attestationEventSchema, raw)
 * if (!result.valid) {
 *   console.warn('Poison message:', result.detail)
 *   return
 * }
 * await process(result.data)
 * ```
 */
export function validateMessage<T>(
  schema: ZodType<T>,
  rawPayload: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(rawPayload)

  if (result.success) {
    return { valid: true, data: result.data }
  }

  return {
    valid: false,
    reasonCode: DlqReasonCode.SCHEMA_VALIDATION_FAILED,
    detail: formatZodErrors(result.error),
  }
}

// ── DLQ sink interface ────────────────────────────────────────────────────────

/**
 * Minimal sink contract required by `DlqRouter`.
 *
 * Both the concrete `ReplayService` and lightweight test doubles satisfy this
 * interface, keeping the router decoupled from any specific storage backend.
 */
export interface DlqSink {
  captureFailure(type: string, data: unknown, reason: string): Promise<unknown>
}

// ── DLQ router ────────────────────────────────────────────────────────────────

/**
 * Routes poison messages to the configured dead-letter sink.
 *
 * Each entry is tagged with a structured `[REASON_CODE] detail` string so
 * operators can filter by reason code without parsing free-form text.
 *
 * @example
 * ```ts
 * const router = new DlqRouter(replayService)
 * await router.route('attestation', rawEvent, DlqReasonCode.SCHEMA_VALIDATION_FAILED, errors)
 * ```
 */
export class DlqRouter {
  constructor(private readonly sink: DlqSink) {}

  /**
   * Persist a poison message to the dead-letter queue.
   *
   * @param messageType - Event label used to look up replay handlers later
   *                      (e.g. `"attestation"`, `"withdrawal"`).
   * @param rawPayload  - The original, unmodified message as received.
   * @param reasonCode  - Standardised `DlqReasonCode` for the failure.
   * @param detail      - Human-readable context (field errors, exception message…).
   */
  async route(
    messageType: string,
    rawPayload: unknown,
    reasonCode: DlqReasonCode,
    detail: string,
  ): Promise<void> {
    const reason = `[${reasonCode}] ${detail}`
    await this.sink.captureFailure(messageType, rawPayload, reason)
  }
}

// ── Combined validate-and-route ───────────────────────────────────────────────

/**
 * Validate a raw payload and, if it fails, immediately route it to the DLQ.
 *
 * This helper collapses the common pattern of "validate then optionally DLQ"
 * into a single `await`.  The returned `ValidationResult` uses the same
 * discriminated union as `validateMessage`, so callers can narrow on
 * `result.valid` to access the typed data or skip processing cleanly.
 *
 * @example
 * ```ts
 * const result = await validateAndRoute(
 *   withdrawalEventSchema,
 *   'withdrawal',
 *   incomingPayload,
 *   dlqRouter,
 * )
 * if (!result.valid) return   // already persisted in DLQ
 * await handleWithdrawal(result.data)
 * ```
 */
export async function validateAndRoute<T>(
  schema: ZodType<T>,
  messageType: string,
  rawPayload: unknown,
  dlqRouter: DlqRouter,
): Promise<ValidationResult<T>> {
  const result = validateMessage(schema, rawPayload)

  if (!result.valid) {
    await dlqRouter.route(messageType, rawPayload, result.reasonCode, result.detail)
  }

  return result
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function formatZodErrors(error: ZodError): string {
   // Zod v4 exposes issues via `.issues`; v3 used `.errors` (aliased in v4 for compat).
   const issues: ZodIssue[] = (error as any).issues ?? (error as any).errors ?? []
   return issues
     .map((issue: ZodIssue) => {
       const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
       return `${path}: ${issue.message}`
     })
     .join('; ')
 }

// ── Bond Event Schemas ──────────────────────────────────────────────────────────────
/**
 * Schema for bond creation operation from Horizon
 * Validates that source_account is a valid Stellar account ID,
 * amount is a non-negative integer string, and duration is either null or a string
 */
export const bondOperationSchema = z.object({
  source_account: z.string().refine(
    (account): boolean => {
      try {
        return StrKey.isValidEd25519PublicKey(account) || ((StrKey as unknown as { isValidMuxedAccount?: (value: string) => boolean }).isValidMuxedAccount?.(account) ?? false);
      } catch {
        return false;
      }
    },
    { message: 'Invalid Stellar account ID' }
  ),
  id: z.string().min(1, 'Operation ID is required'),
  amount: z.string().refine(
    (amount): boolean => {
      // Check if it's a non-negative integer string
      return /^\d+$/.test(amount);
    },
    { message: 'Amount must be a non-negative integer string' }
  ),
  duration: z.union([z.string(), z.null()]).optional(),
});

/**
 * Schema for bond withdrawal operation from Horizon
 * Similar to bond creation but for withdrawal operations
 */
export const bondWithdrawalOperationSchema = z.object({
  source_account: z.string().refine(
    (account): boolean => {
      try {
        return StrKey.isValidEd25519PublicKey(account) || ((StrKey as unknown as { isValidMuxedAccount?: (value: string) => boolean }).isValidMuxedAccount?.(account) ?? false);
      } catch {
        return false;
      }
    },
    { message: 'Invalid Stellar account ID' }
  ),
  id: z.string().min(1, 'Operation ID is required'),
  amount: z.string().refine(
    (amount): boolean => {
      // Check if it's a non-negative integer string
      return /^\d+$/.test(amount);
    },
    { message: 'Amount must be a non-negative integer string' }
  ),
  duration: z.union([z.string(), z.null()]).optional(),
});

// Export types for convenience
export type BondOperation = z.infer<typeof bondOperationSchema>;
export type BondWithdrawalOperation = z.infer<typeof bondWithdrawalOperationSchema>;
