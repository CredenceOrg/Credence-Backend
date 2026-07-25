import { z } from 'zod'

/**
 * Valid settlement status values.
 * Issue #325: Validate status enum to prevent unvalidated status values
 * from reaching the settlement layer.
 */
export const PAYOUT_STATUS_ENUM = ['pending', 'settled', 'failed'] as const

/**
 * Schema for creating a payout (settlement).
 *
 * Issue #325: Tightened validation for amount precision/range and status enum.
 * - amount: Must be a valid non-negative numeric string with at most 18 decimal places
 *   (Stellar precision) and a reasonable max value.
 * - status: Restricted to the SettlementStatus enum values.
 * - settledAt: Validated as ISO 8601 datetime; invalid dates are rejected with 400.
 */
export const createPayoutSchema = z.object({
  bondId: z.union([z.string(), z.number()]),
  /**
   * Amount must be a valid non-negative numeric string.
   * - Max 18 decimal places (Stellar precision).
   * - Must not be negative (no leading minus sign).
   * - Maximum value: 1e18 (prevents overflow in downstream calculations).
   */
  amount: z
    .string()
    .regex(
      /^\d+(\.\d{1,18})?$/,
      'Must be a valid non-negative numeric string with at most 18 decimal places'
    )
    .refine(
      (val) => {
        const num = parseFloat(val)
        return num >= 0 && num <= 1e18
      },
      { message: 'Amount must be between 0 and 1e18' }
    ),
  transactionHash: z.string().min(1).max(128),
  /**
   * Issue #325: settledAt is validated as ISO 8601 datetime.
   * Invalid dates (e.g., "not-a-date") are rejected with a 400 error
   * instead of propagating as invalid Date objects that cause 500 errors.
   */
  settledAt: z.string().datetime({ message: 'settledAt must be a valid ISO 8601 datetime string' }).optional(),
  /**
   * Issue #325: status is restricted to the SettlementStatus enum
   * to prevent typos and shape drift from reaching the settlement layer.
   */
  status: z.enum(PAYOUT_STATUS_ENUM).optional(),
})

/**
 * Issue #325: Inferred type from the Zod schema replaces the unsafe `as any` cast.
 * This type is used in the payouts route and aligned with SettlementService input.
 */
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>
