import { describe, it, expect } from 'vitest'
import { addressSchema } from './address.js'

describe('addressSchema', () => {
  it('accepts valid 0x-prefixed 40-char hex address', () => {
    expect(addressSchema.parse('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(
      '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    )
    expect(addressSchema.parse('0x' + 'a'.repeat(40))).toBe('0x' + 'a'.repeat(40))
    expect(addressSchema.parse('0x' + 'A'.repeat(40))).toBe('0x' + 'A'.repeat(40))
  })

  it('rejects empty string', () => {
    const r = addressSchema.safeParse('')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toContain('required')
  })

  it('rejects missing 0x prefix', () => {
    const r = addressSchema.safeParse('742d35Cc6634C0532925a3b844Bc454e4438f44e')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/0x|hex/)
  })

  it('rejects wrong length (too short)', () => {
    const r = addressSchema.safeParse('0x' + 'a'.repeat(39))
    expect(r.success).toBe(false)
  })

  it('rejects wrong length (too long)', () => {
    const r = addressSchema.safeParse('0x' + 'a'.repeat(41))
    expect(r.success).toBe(false)
  })

  it('rejects non-hex characters', () => {
    const r = addressSchema.safeParse('0x742d35Cc6634C0532925a3b844Bc454e4438f44g')
    expect(r.success).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(addressSchema.safeParse(123).success).toBe(false)
    expect(addressSchema.safeParse(null).success).toBe(false)
  })
})
