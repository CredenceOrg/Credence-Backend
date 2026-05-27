import { describe, it, expect } from 'vitest'
import {
  attestationIdentityParamsSchema,
  attestationsPathParamsSchema,
  attestationsQuerySchema,
  createAttestationBodySchema,
  ATTESTATION_CLAIM_MAX_LENGTH,
} from './attestations.js'

const validAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
const validVerifier = '0x1234567890123456789012345678901234567890'

describe('attestationIdentityParamsSchema', () => {
  it('accepts valid address', () => {
    expect(attestationIdentityParamsSchema.parse({ identity: validAddress })).toEqual({
      identity: validAddress,
    })
  })

  it('rejects invalid address', () => {
    expect(attestationIdentityParamsSchema.safeParse({ identity: 'x' }).success).toBe(false)
  })
})

describe('attestationsPathParamsSchema', () => {
  it('accepts valid address', () => {
    expect(attestationsPathParamsSchema.parse({ address: validAddress })).toEqual({
      address: validAddress,
    })
  })
})

describe('attestationsQuerySchema', () => {
  it('uses defaults when empty', () => {
    expect(attestationsQuerySchema.parse({})).toEqual({ page: 1, limit: 20, offset: 0 })
  })

  it('coerces and accepts valid page, limit and offset', () => {
    expect(attestationsQuerySchema.parse({ page: '2', limit: '50', offset: '10' })).toEqual({
      page: 2,
      limit: 50,
      offset: 10,
    })
  })

  it('rejects page < 1', () => {
    expect(attestationsQuerySchema.safeParse({ page: 0 }).success).toBe(false)
  })

  it('rejects limit > 100', () => {
    expect(attestationsQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
  })
})

describe('createAttestationBodySchema', () => {
  it('accepts subject, verifier, weight, and claim', () => {
    expect(
      createAttestationBodySchema.parse({
        subject: validAddress,
        verifier: validVerifier,
        weight: 50,
        claim: 'verified',
      }),
    ).toEqual({
      subject: validAddress,
      verifier: validVerifier,
      weight: 50,
      claim: 'verified',
    })
  })

  it('accepts optional bondId', () => {
    expect(
      createAttestationBodySchema.parse({
        subject: validAddress,
        verifier: validVerifier,
        weight: 10,
        claim: 'x',
        bondId: 1,
      }),
    ).toMatchObject({ bondId: 1 })
  })

  it('rejects missing claim', () => {
    expect(
      createAttestationBodySchema.safeParse({
        subject: validAddress,
        verifier: validVerifier,
        weight: 50,
      }),
    ).toMatchObject({ success: false })
  })

  it('rejects oversized claim', () => {
    expect(
      createAttestationBodySchema.safeParse({
        subject: validAddress,
        verifier: validVerifier,
        weight: 50,
        claim: 'x'.repeat(ATTESTATION_CLAIM_MAX_LENGTH + 1),
      }),
    ).toMatchObject({ success: false })
  })

  it('rejects invalid weight', () => {
    expect(
      createAttestationBodySchema.safeParse({
        subject: validAddress,
        verifier: validVerifier,
        weight: 200,
        claim: 'x',
      }),
    ).toMatchObject({ success: false })
  })
})
