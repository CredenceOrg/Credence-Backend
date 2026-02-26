import { describe, it, expect } from 'vitest'
import { trustPathParamsSchema, trustQuerySchema } from './trust.js'

const validAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'

describe('trustPathParamsSchema', () => {
  it('accepts valid address', () => {
    expect(trustPathParamsSchema.parse({ address: validAddress })).toEqual({
      address: validAddress,
    })
  })

  it('rejects invalid address', () => {
    expect(trustPathParamsSchema.safeParse({ address: 'invalid' }).success).toBe(false)
  })
})

describe('trustQuerySchema', () => {
  it('accepts empty object', () => {
    expect(trustQuerySchema.parse({})).toEqual({})
  })
})
