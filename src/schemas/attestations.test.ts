import { describe, it, expect } from 'vitest'
import {
  attestationsPathParamsSchema,
  attestationsQuerySchema,
  createAttestationBodySchema,
} from './attestations.js'

const validAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'

describe('attestationsPathParamsSchema', () => {
  it('accepts valid address', () => {
    expect(attestationsPathParamsSchema.parse({ address: validAddress })).toEqual({
      address: validAddress,
    })
  })

  it('rejects invalid address', () => {
    expect(attestationsPathParamsSchema.safeParse({ address: 'x' }).success).toBe(false)
  })
})

describe('attestationsQuerySchema', () => {
  it('uses defaults when empty', () => {
    expect(attestationsQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 })
  })

  it('coerces and accepts valid limit and offset', () => {
    expect(attestationsQuerySchema.parse({ limit: '50', offset: '10' })).toEqual({
      limit: 50,
      offset: 10,
    })
  })

  it('rejects limit > 100', () => {
    expect(attestationsQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
  })

  it('rejects negative offset', () => {
    expect(attestationsQuerySchema.safeParse({ offset: -1 }).success).toBe(false)
  })
})

describe('createAttestationBodySchema', () => {
  it('accepts subject and value', () => {
    expect(
      createAttestationBodySchema.parse({ subject: validAddress, value: 'v' }),
    ).toEqual({ subject: validAddress, value: 'v' })
  })

  it('accepts optional key', () => {
    expect(
      createAttestationBodySchema.parse({
        subject: validAddress,
        value: 'v',
        key: 'k',
      }),
    ).toEqual({ subject: validAddress, value: 'v', key: 'k' })
  })

  it('rejects missing value', () => {
    expect(
      createAttestationBodySchema.safeParse({ subject: validAddress }),
    ).toMatchObject({ success: false })
  })

  it('rejects empty value', () => {
    expect(
      createAttestationBodySchema.safeParse({
        subject: validAddress,
        value: '',
      }),
    ).toMatchObject({ success: false })
  })

  it('rejects invalid subject address', () => {
    expect(
      createAttestationBodySchema.safeParse({ subject: '0xbad', value: 'v' }),
    ).toMatchObject({ success: false })
  })
})
