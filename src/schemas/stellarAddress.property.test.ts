import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { isValidStellarAddress } from '../lib/stellarAddress.js'
import { stellarAddressSchema } from './address.js'

describe('Stellar Address Property-based Tests', () => {
  // Generator for valid Stellar characters (A-Z, 2-7)
  const stellarCharArb = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split(''))

  // Generator for valid G-addresses: 'G' followed by 55 valid Stellar base32 characters
  const validStellarAddressArb = fc
    .array(stellarCharArb, { minLength: 55, maxLength: 55 })
    .map((chars) => 'G' + chars.join(''))

  // Generator for invalid prefixes (any character other than 'G', including lowercase g)
  const invalidPrefixCharArb = fc.constantFrom(
    ...'ABCDEFHIJKLMNOPQRSTUVWXYZ234567abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()'.split('')
  )

  it('should accept all valid G-addresses', () => {
    fc.assert(
      fc.property(validStellarAddressArb, (address) => {
        expect(isValidStellarAddress(address)).toBe(true)
        expect(stellarAddressSchema.safeParse(address).success).toBe(true)
      })
    )
  })

  it('should reject addresses with invalid prefixes', () => {
    const invalidPrefixArb = fc
      .tuple(
        invalidPrefixCharArb,
        fc.array(stellarCharArb, { minLength: 55, maxLength: 55 })
      )
      .map(([prefix, chars]) => prefix + chars.join(''))

    fc.assert(
      fc.property(invalidPrefixArb, (address) => {
        expect(isValidStellarAddress(address)).toBe(false)
        expect(stellarAddressSchema.safeParse(address).success).toBe(false)
      })
    )
  })

  it('should reject addresses with incorrect lengths', () => {
    // Generate valid-looking Stellar addresses but with lengths other than 56
    const invalidLengthArb = fc
      .array(stellarCharArb)
      .filter((chars) => chars.length !== 55)
      .map((chars) => 'G' + chars.join(''))

    fc.assert(
      fc.property(invalidLengthArb, (address) => {
        expect(isValidStellarAddress(address)).toBe(false)
        expect(stellarAddressSchema.safeParse(address).success).toBe(false)
      })
    )
  })

  it('should reject addresses with malformed/invalid characters', () => {
    const invalidChars = 'abcdefghijklmnopqrstuvwxyz0189!@#$%^&*()_+ '.split('')
    const invalidCharGenerator = fc.constantFrom(...invalidChars)

    const malformedAddressArb = fc
      .tuple(
        fc.integer({ min: 1, max: 55 }), // index of the invalid char
        fc.array(stellarCharArb, { minLength: 54, maxLength: 54 }),
        invalidCharGenerator
      )
      .map(([index, validChars, invalidChar]) => {
        const chars = [...validChars]
        chars.splice(index - 1, 0, invalidChar)
        return 'G' + chars.join('')
      })

    fc.assert(
      fc.property(malformedAddressArb, (address) => {
        expect(isValidStellarAddress(address)).toBe(false)
        expect(stellarAddressSchema.safeParse(address).success).toBe(false)
      })
    )
  })

  it('should reject checksum corruption / single character mutations', () => {
    // To corrupt the address under the regex rules, we must replace one char with an invalid char
    const invalidChars = 'abcdefghijklmnopqrstuvwxyz0189!@#$%^&*()_+ '.split('')
    const invalidCharGenerator = fc.constantFrom(...invalidChars)

    const mutatedAddressArb = fc
      .tuple(
        validStellarAddressArb,
        fc.integer({ min: 1, max: 55 }),
        invalidCharGenerator
      )
      .map(([address, index, invalidChar]) => {
        const mutated = address.substring(0, index) + invalidChar + address.substring(index + 1)
        return mutated
      })

    fc.assert(
      fc.property(mutatedAddressArb, (address) => {
        expect(isValidStellarAddress(address)).toBe(false)
        expect(stellarAddressSchema.safeParse(address).success).toBe(false)
      })
    )
  })

  it('should reject arbitrary garbage inputs', () => {
    fc.assert(
      fc.property(fc.string(), (address) => {
        if (/^G[A-Z2-7]{55}$/.test(address)) {
          return
        }
        expect(isValidStellarAddress(address)).toBe(false)
        expect(stellarAddressSchema.safeParse(address).success).toBe(false)
      })
    )
  })
})
