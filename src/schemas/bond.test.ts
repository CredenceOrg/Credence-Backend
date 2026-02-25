import { describe, it, expect } from 'vitest'
import { bondPathParamsSchema, bondQuerySchema } from './bond.js'

const validAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'

describe('bondPathParamsSchema', () => {
  it('accepts valid address', () => {
    expect(bondPathParamsSchema.parse({ address: validAddress })).toEqual({
      address: validAddress,
    })
  })

  it('rejects invalid address', () => {
    expect(bondPathParamsSchema.safeParse({ address: 'x' }).success).toBe(false)
  })
})

describe('bondQuerySchema', () => {
  it('accepts empty object', () => {
    expect(bondQuerySchema.parse({})).toEqual({})
  })
})
