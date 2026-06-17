import { z } from 'zod'
import { addressSchema } from './address.js'

/**
 * Path params for GET /api/bond/:address
 */
export const bondPathParamsSchema = z.object({
  address: addressSchema.openapi({
    description: 'Ethereum (0x…) or Stellar (G…) wallet address',
    example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  }),
}).openapi('BondPathParams')

/**
 * Optional query params for bond endpoint
 */
export const bondQuerySchema = z.object({}).strict().openapi('BondQuery')

/**
 * Body schema for POST /api/bond — create or top-up a bond
 */
export const createBondBodySchema = z.object({
  address: addressSchema.openapi({
    description: 'Wallet address to associate the bond with',
    example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  }),
  bondedAmount: z.string().min(1).openapi({
    description: 'Amount to bond, expressed as a string to preserve precision (e.g. wei)',
    example: '1000000000000000000',
  }),
  bondDuration: z.number().int().positive().openapi({
    description: 'Bond lock duration in seconds',
    example: 2592000,
  }),
}).openapi('CreateBondBody')

/**
 * Response schema for GET /api/bond/:address
 */
export const bondResponseSchema = z.object({
  address: z.string().openapi({
    description: 'Normalised (lower-case) wallet address',
    example: '0x742d35cc6634c0532925a3b844bc454e4438f44e',
  }),
  bondedAmount: z.string().openapi({
    description: 'Current bonded amount as a string',
    example: '1000000000000000000',
  }),
  bondStart: z.string().nullable().openapi({
    description: 'ISO 8601 timestamp when the bond was first posted, or null',
    example: '2024-01-15T10:00:00.000Z',
  }),
  bondDuration: z.number().nullable().openapi({
    description: 'Bond lock duration in seconds, or null if unbonded',
    example: 2592000,
  }),
  active: z.boolean().openapi({
    description: 'Deprecated: use `status` instead',
    example: true,
  }),
  slashedAmount: z.string().openapi({
    description: 'Cumulative slashed amount as a string',
    example: '0',
  }),
  status: z.enum(['active', 'slashed', 'inactive', 'unbonded']).openapi({
    description: 'Canonical bond lifecycle status',
    example: 'active',
  }),
}).openapi('BondResponse')

/**
 * Standard error response schema
 */
export const bondErrorSchema = z.object({
  error: z.string().openapi({ example: 'No bond record found for address 0x…' }),
}).openapi('BondError')

export type BondPathParams = z.infer<typeof bondPathParamsSchema>
export type BondQuery = z.infer<typeof bondQuerySchema>
export type CreateBondBody = z.infer<typeof createBondBodySchema>
export type BondResponse = z.infer<typeof bondResponseSchema>
