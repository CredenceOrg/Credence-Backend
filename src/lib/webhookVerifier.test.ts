import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  parseSignatureHeader,
  computeHmac,
  safeCompareHex,
  verifySignature,
} from './webhookVerifier.js'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

// ---------------------------------------------------------------------------
// parseSignatureHeader
// ---------------------------------------------------------------------------

describe('parseSignatureHeader', () => {
  it('returns null for null input', () => {
    expect(parseSignatureHeader(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseSignatureHeader(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseSignatureHeader('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseSignatureHeader('   ')).toBeNull()
  })

  it('returns null for non-hex content', () => {
    expect(parseSignatureHeader('sha256=not-hex')).toBeNull()
  })

  it('returns null for wrong-length hex (too short)', () => {
    expect(parseSignatureHeader('abc123')).toBeNull()
  })

  it('returns null for wrong-length hex (63 chars)', () => {
    expect(parseSignatureHeader('a'.repeat(63))).toBeNull()
  })

  it('accepts bare 64-char hex', () => {
    const hex = 'a'.repeat(64)
    expect(parseSignatureHeader(hex)).toBe(hex)
  })

  it('accepts sha256= prefixed hex (lowercase)', () => {
    const hex = 'b'.repeat(64)
    expect(parseSignatureHeader(`sha256=${hex}`)).toBe(hex)
  })

  it('accepts sha256= prefixed hex (mixed case prefix)', () => {
    const hex = 'c'.repeat(64)
    expect(parseSignatureHeader(`SHA256=${hex}`)).toBe(hex)
  })

  it('normalises to lowercase', () => {
    const hex = 'ABCDEF'.repeat(10) + 'ABCD'
    expect(parseSignatureHeader(hex)).toBe(hex.toLowerCase())
  })
})

// ---------------------------------------------------------------------------
// computeHmac
// ---------------------------------------------------------------------------

describe('computeHmac', () => {
  it('returns the correct HMAC-SHA256 hex digest', () => {
    const body = '{"hello":"world"}'
    const secret = 'my-secret'
    expect(computeHmac(body, secret)).toBe(sign(body, secret))
  })
})

// ---------------------------------------------------------------------------
// safeCompareHex
// ---------------------------------------------------------------------------

describe('safeCompareHex', () => {
  it('returns true for identical digests', () => {
    const hex = sign('body', 'secret')
    expect(safeCompareHex(hex, hex)).toBe(true)
  })

  it('returns false for different digests of same length', () => {
    const a = sign('body-a', 'secret')
    const b = sign('body-b', 'secret')
    expect(safeCompareHex(a, b)).toBe(false)
  })

  it('returns false when lengths differ', () => {
    expect(safeCompareHex('a'.repeat(64), 'a'.repeat(32))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  const secret = 'test-secret'
  const body = '{"event":"bond.created"}'
  const validSig = sign(body, secret)

  it('returns missing_secret when secret is null', () => {
    const result = verifySignature(validSig, body, null)
    expect(result).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('returns missing_secret when secret is undefined', () => {
    const result = verifySignature(validSig, body, undefined)
    expect(result).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('returns missing_secret when secret is empty string', () => {
    const result = verifySignature(validSig, body, '')
    expect(result).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('returns missing_signature when rawSignature is null', () => {
    const result = verifySignature(null, body, secret)
    expect(result).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('returns missing_signature when rawSignature is undefined', () => {
    const result = verifySignature(undefined, body, secret)
    expect(result).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('returns missing_signature when rawSignature is empty string', () => {
    const result = verifySignature('', body, secret)
    expect(result).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('returns malformed_signature for non-hex header value', () => {
    const result = verifySignature('sha256=not-hex', body, secret)
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('returns malformed_signature for wrong-length hex', () => {
    const result = verifySignature('deadbeef', body, secret)
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('returns invalid_signature when signature does not match', () => {
    const wrongSig = sign(body, 'wrong-secret')
    const result = verifySignature(wrongSig, body, secret)
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('returns ok:true for a valid bare-hex signature', () => {
    const result = verifySignature(validSig, body, secret)
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:true for a valid sha256= prefixed signature', () => {
    const result = verifySignature(`sha256=${validSig}`, body, secret)
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:true for sha256= prefix with uppercase', () => {
    const result = verifySignature(`SHA256=${validSig}`, body, secret)
    expect(result).toEqual({ ok: true })
  })
})
