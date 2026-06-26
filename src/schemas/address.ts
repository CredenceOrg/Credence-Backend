import { z } from './openapi.js'
import { isValidStellarAddress } from '../lib/stellarAddress.js'

/**
 * Ethereum-style address (0x + 40 hex chars) or Stellar G-address (G + 55 base32 chars).
 * Used for path params and general endpoints accepting both address types.
 * Invokes the existing isValidStellarAddress validation helper for Stellar addresses.
 */
export const addressSchema = z
  .string()
  .min(1, 'Address is required')
  .superRefine((val, ctx) => {
    // If the input is clearly intended as an Ethereum address (starts with 0x, is 40 chars, or matches hex)
    if (val.startsWith('0x') || val.length === 40 || /^[a-fA-F0-9]{40}$/.test(val)) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Address must be a valid Ethereum (0x...) or Stellar (G...) address',
        })
      }
    } else {
      // Otherwise, treat as a Stellar address and check strict validity
      if (!isValidStellarAddress(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'INVALID_STELLAR_ADDRESS',
        })
      }
    }
  })

/** Validated address string. */
export type Address = z.infer<typeof addressSchema>

/**
 * Stellar StrKey G-address: G + 55 characters from the base32 alphabet (A–Z, 2–7).
 * Uses the existing isValidStellarAddress helper from src/lib/stellarAddress.ts.
 * All schemas that accept Stellar-specific address fields should use this schema
 * so validation occurs at the request edge before services/repositories.
 */
export const stellarAddressSchema = z
  .string()
  .min(1, 'Stellar address is required')
  .refine(isValidStellarAddress, { message: 'INVALID_STELLAR_ADDRESS' })

/** Validated Stellar address string (G + 55 base32 chars). */
export type StellarAddress = z.infer<typeof stellarAddressSchema>
