import { z } from 'zod'
import { addressSchema } from './address.js'

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
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict()

/**
 * Body schema for creating an attestation (POST)
 */
export const createAttestationBodySchema = z
  .object({
    subject: addressSchema,
    value: z.string().min(1, 'Attestation value is required'),
    key: z.string().min(1).optional(),
  })
  .strict()

export type AttestationsPathParams = z.infer<typeof attestationsPathParamsSchema>
export type AttestationsQuery = z.infer<typeof attestationsQuerySchema>
export type CreateAttestationBody = z.infer<typeof createAttestationBodySchema>
