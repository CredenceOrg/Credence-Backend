import { z } from 'zod'

// ISO-8601 datetime regex — covers `2024-01-15T10:30:00Z` and offset variants.
// Avoids reliance on Zod's `.datetime()` method whose API changed across versions.
const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Non-negative decimal string (e.g. "500.0000000"). */
const decimalAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Amount must be a non-negative decimal string')

/**
 * Runtime schema for attestation events received from the Horizon event stream.
 *
 * Validates the shape of inbound `add` and `revoke` messages before any store
 * operations are attempted, so malformed payloads are caught at the boundary
 * and routed to the DLQ rather than triggering partial writes.
 */
export const attestationEventSchema = z.object({
  id: z.string().min(1, 'Event ID is required'),
  pagingToken: z.string().min(1, 'Paging token is required'),
  type: z.enum(['add', 'revoke']),
  subject: z.string().min(1, 'Subject address is required'),
  verifier: z.string().min(1, 'Verifier address is required'),
  weight: z
    .number()
    .int('Weight must be an integer')
    .min(0, 'Weight must be at least 0')
    .max(100, 'Weight must be at most 100'),
  claim: z.string(),
  createdAt: z
    .string()
    .regex(iso8601Regex, 'createdAt must be a valid ISO-8601 datetime string'),
  transactionHash: z.string().min(1, 'Transaction hash is required'),
})

/**
 * Runtime schema for bond withdrawal events sourced from Stellar Horizon.
 *
 * Accepts either a `Date` object or an ISO-8601 string for `createdAt` to
 * handle both raw Horizon payloads and already-parsed records.
 */
export const withdrawalEventSchema = z.object({
  id: z.string().min(1, 'Event ID is required'),
  pagingToken: z.string().min(1, 'Paging token is required'),
  type: z.string().min(1, 'Operation type is required'),
  createdAt: z.union([
    z.date(),
    z.string().regex(iso8601Regex, 'createdAt must be a valid ISO-8601 datetime string'),
  ]),
  bondId: z.string().min(1, 'Bond ID is required'),
  account: z.string().min(1, 'Account address is required'),
  amount: decimalAmountSchema,
  assetType: z.string().min(1, 'Asset type is required'),
  assetCode: z.string().optional(),
  assetIssuer: z.string().optional(),
  transactionHash: z.string().min(1, 'Transaction hash is required'),
  operationIndex: z.number().int().min(0, 'Operation index must be non-negative'),
})

/**
 * Runtime schema for bond creation events sourced from the Horizon stream.
 *
 * Mirrors the structure produced by `parseBondEvent` in horizonBondEvents.ts,
 * including the `create_bond` literal discriminant used for type narrowing.
 */
export const bondCreationEventSchema = z.object({
  id: z.string().min(1, 'Operation ID is required'),
  type: z.literal('create_bond'),
  sourceAccount: z.string().min(1, 'Source account is required'),
  amount: decimalAmountSchema,
  duration: z.string().nullable().optional(),
  pagingToken: z.string().optional(),
  transactionHash: z.string().optional(),
})

export type AttestationEventPayload = z.infer<typeof attestationEventSchema>
export type WithdrawalEventPayload = z.infer<typeof withdrawalEventSchema>
export type BondCreationEventPayload = z.infer<typeof bondCreationEventSchema>
