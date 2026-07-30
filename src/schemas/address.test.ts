import { describe, it, expect } from 'vitest'
import { addressSchema, stellarAddressSchema } from './address.js'

describe('addressSchema', () => {
  it('accepts valid 0x-prefixed 40-char hex address', () => {
    expect(addressSchema.parse('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(
      '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    )
    expect(addressSchema.parse('0x' + 'a'.repeat(40))).toBe('0x' + 'a'.repeat(40))
    expect(addressSchema.parse('0x' + 'A'.repeat(40))).toBe('0x' + 'A'.repeat(40))
  })

  it('accepts valid Stellar G-address', () => {
    const validStellar = 'G' + 'A'.repeat(55)
    expect(addressSchema.parse(validStellar)).toBe(validStellar)
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

describe('stellarAddressSchema', () => {
  const validG = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'

  it('accepts a valid G-address', () => {
    expect(stellarAddressSchema.parse(validG)).toBe(validG)
  })

  it('accepts a generated valid G-address (G + 55 base32 chars)', () => {
    const addr = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55)
    expect(stellarAddressSchema.parse(addr)).toBe(addr)
  })

  it('rejects empty string', () => {
    const r = stellarAddressSchema.safeParse('')
    expect(r.success).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(stellarAddressSchema.safeParse(123).success).toBe(false)
    expect(stellarAddressSchema.safeParse(null).success).toBe(false)
    expect(stellarAddressSchema.safeParse(undefined).success).toBe(false)
  })

  it('rejects wrong prefix (not G)', () => {
    const addr = 'A' + 'A'.repeat(55)
    const r = stellarAddressSchema.safeParse(addr)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => i.message === 'INVALID_STELLAR_ADDRESS')).toBe(true)
  })

  it('rejects too-short address', () => {
    const addr = 'G' + 'A'.repeat(54)
    const r = stellarAddressSchema.safeParse(addr)
    expect(r.success).toBe(false)
  })

  it('rejects too-long address', () => {
    const addr = 'G' + 'A'.repeat(56)
    const r = stellarAddressSchema.safeParse(addr)
    expect(r.success).toBe(false)
  })

  it('rejects lowercase letters in address', () => {
    const addr = 'G' + 'a'.repeat(55)
    const r = stellarAddressSchema.safeParse(addr)
    expect(r.success).toBe(false)
  })

  it('rejects invalid base32 characters (0, 1, 8, 9)', () => {
    // 0, 1, 8, 9 are not valid in Stellar base32 (only A-Z and 2-7)
    for (const ch of ['0', '1', '8', '9']) {
      const addr = 'G' + ch + 'A'.repeat(54)
      const r = stellarAddressSchema.safeParse(addr)
      expect(r.success).toBe(false)
    }
  })

  it('rejects special characters', () => {
    const addr = 'G' + '+'.repeat(55)
    expect(stellarAddressSchema.safeParse(addr).success).toBe(false)
  })

  it('rejects M-address (muxed accounts not supported)', () => {
    const addr = 'M' + 'A'.repeat(55)
    expect(stellarAddressSchema.safeParse(addr).success).toBe(false)
  })

  it('rejects federated addresses', () => {
    expect(stellarAddressSchema.safeParse('user*domain.com').success).toBe(false)
  })

  it('returns INVALID_STELLAR_ADDRESS message on refinement failure', () => {
    const r = stellarAddressSchema.safeParse('INVALID')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message === 'INVALID_STELLAR_ADDRESS')).toBe(true)
    }
  })
})
