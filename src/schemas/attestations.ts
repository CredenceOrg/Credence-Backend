import { z } from 'zod'
import { addressSchema } from './address.js'

/** Max lengths for attestation payload fields (security). */
export const ATTESTATION_CLAIM_MAX_LENGTH = 4096

/**
 * Path params for attestation routes (e.g. GET /api/attestations/:identity)
 */
export const attestationIdentityParamsSchema = z.object({
  identity: addressSchema,
})

/** Legacy alias used by app-level validation exports. */
export const attestationsPathParamsSchema = z.object({
  address: addressSchema,
})

/**
 * Query params for listing attestations (pagination, filters)
 */
export const attestationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    cursor: z.string().optional(),
    includeRevoked: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .strict()

/** Legacy alias for pagination-only query validation. */
export const attestationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
    cursor: z.string().optional(),
  })
  .strict()

/**
 * Body schema for creating an attestation (POST)
 */
export const createAttestationBodySchema = z
  .object({
    subject: addressSchema,
    verifier: addressSchema,
    weight: z
      .number()
      .int('Weight must be an integer')
      .min(0, 'Weight must be at least 0')
      .max(100, 'Weight must be at most 100'),
    claim: z
      .string()
      .min(1, 'Attestation claim is required')
      .max(ATTESTATION_CLAIM_MAX_LENGTH, `Claim must be at most ${ATTESTATION_CLAIM_MAX_LENGTH} characters`),
    bondId: z.coerce.number().int().positive().optional(),
  })
  .strict()

export type AttestationIdentityParams = z.infer<typeof attestationIdentityParamsSchema>
export type AttestationsPathParams = z.infer<typeof attestationsPathParamsSchema>
export type AttestationsQuery = z.infer<typeof attestationsQuerySchema>
export type CreateAttestationBody = z.infer<typeof createAttestationBodySchema>
