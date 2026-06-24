import { z } from 'zod'
import { addressSchema, stellarAddressSchema } from './address.js'

/**
 * Path params for attestation routes (e.g. GET /api/attestations/:address)
 */
export const attestationsPathParamsSchema = z.object({
  address: addressSchema,
})

/**
 * Query params for listing attestations (pagination, filters)
 */
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
    bondId: z.coerce.number().int().positive('Bond ID is required').optional(),
    attesterAddress: addressSchema.optional(),
    subject: addressSchema,
    value: z.string().min(1, 'Attestation value is required').max(2048, 'Attestation value is too large'),
    key: z.string().min(1).max(128).optional(),
    score: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict()

export type AttestationsPathParams = z.infer<typeof attestationsPathParamsSchema>
export type AttestationsQuery = z.infer<typeof attestationsQuerySchema>
export type CreateAttestationBody = z.infer<typeof createAttestationBodySchema>
