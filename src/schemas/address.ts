import { z } from 'zod'

/**
 * Ethereum-style address: 0x prefix + 40 hexadecimal characters (20 bytes).
 * Used for path params and any endpoint that takes an address.
 */
export const addressSchema = z
  .string()
  .min(1, 'Address is required')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Address must be a valid 0x-prefixed 40-character hex string')

/** Validated address string (0x + 40 hex chars). */
export type Address = z.infer<typeof addressSchema>
