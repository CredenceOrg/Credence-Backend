/**
 * Central export for request validation schemas.
 * Use with validate middleware for path, query, and body validation.
 */
export { addressSchema, type Address } from './address.js'
export {
  trustPathParamsSchema,
  trustQuerySchema,
  type TrustPathParams,
  type TrustQuery,
} from './trust.js'
export {
  bondPathParamsSchema,
  bondQuerySchema,
  type BondPathParams,
  type BondQuery,
} from './bond.js'
export {
  attestationsPathParamsSchema,
  attestationsQuerySchema,
  createAttestationBodySchema,
  type AttestationsPathParams,
  type AttestationsQuery,
  type CreateAttestationBody,
} from './attestations.js'
