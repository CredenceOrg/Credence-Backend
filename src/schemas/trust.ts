import { z } from 'zod'
import { addressSchema } from './address.js'

/**
 * Path params for GET /api/trust/:address
 */
export const trustPathParamsSchema = z.object({
  address: addressSchema,
})

/**
 * Optional query params for trust endpoint (e.g. for future pagination or filters)
 */
export const trustQuerySchema = z.object({}).strict()

export type TrustPathParams = z.infer<typeof trustPathParamsSchema>
export type TrustQuery = z.infer<typeof trustQuerySchema>
