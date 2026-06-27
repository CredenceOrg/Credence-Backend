import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const secret = 'test-secret'
  const body = JSON.stringify({
    event: 'bond.created',
    timestamp: '2026-06-25T12:00:00.000Z'
  })
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

  describe('replay protection with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('rejects payload when timestamp is missing', () => {
      const payload = '{"event":"bond.created","data":{}}'
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: false, reason: 'missing_timestamp' })
    })

    it('rejects payload when timestamp is malformed', () => {
      const payload = '{"event":"bond.created","timestamp":"not-a-date","data":{}}'
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: false, reason: 'invalid_timestamp' })
    })

    it('rejects payload when timestamp is expired (older than default 5 mins)', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T11:54:59.000Z","data":{}}' // 5m 1s ago
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: false, reason: 'expired' })
    })

    it('rejects payload when timestamp is in the future (newer than default 5 mins)', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T12:05:01.000Z","data":{}}' // 5m 1s in future
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: false, reason: 'expired' })
    })

    it('accepts payload when timestamp is exactly at the limit of 5 mins past', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T11:55:00.000Z","data":{}}' // exactly 5 mins ago
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: true })
    })

    it('accepts payload when timestamp is exactly at the limit of 5 mins future', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T12:05:00.000Z","data":{}}' // exactly 5 mins future
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret)
      expect(result).toEqual({ ok: true })
    })

    it('rejects payload when timestamp is outside custom tolerance window', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T11:58:59.000Z","data":{}}' // 1m 1s ago
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret, undefined, { tolerance: 60000 }) // 1 min tolerance
      expect(result).toEqual({ ok: false, reason: 'expired' })
    })

    it('accepts payload when timestamp is within custom tolerance window', () => {
      const payload = '{"event":"bond.created","timestamp":"2026-06-25T11:59:01.000Z","data":{}}' // 59s ago
      const sig = sign(payload, secret)
      const result = verifySignature(sig, payload, secret, undefined, { tolerance: 60000 }) // 1 min tolerance
      expect(result).toEqual({ ok: true })
    })
  })
})
