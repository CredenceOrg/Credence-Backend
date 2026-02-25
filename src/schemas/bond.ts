import { z } from 'zod'
import { addressSchema } from './address.js'

/**
 * Path params for GET /api/bond/:address
 */
export const bondPathParamsSchema = z.object({
  address: addressSchema,
})

/**
 * Optional query params for bond endpoint
 */
export const bondQuerySchema = z.object({}).strict()

export type BondPathParams = z.infer<typeof bondPathParamsSchema>
export type BondQuery = z.infer<typeof bondQuerySchema>
