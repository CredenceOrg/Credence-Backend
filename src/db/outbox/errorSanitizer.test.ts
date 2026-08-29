import { describe, it, expect } from 'vitest'
import { sanitizeErrorMessage, MAX_ERROR_MESSAGE_LENGTH } from './errorSanitizer.js'

describe('sanitizeErrorMessage', () => {
  it('returns an empty string for null/undefined/empty input', () => {
    expect(sanitizeErrorMessage(null)).toBe('')
    expect(sanitizeErrorMessage(undefined)).toBe('')
    expect(sanitizeErrorMessage('')).toBe('')
  })

  it('leaves an ordinary short error message unchanged', () => {
    expect(sanitizeErrorMessage('connect ECONNREFUSED 127.0.0.1:443')).toBe(
      'connect ECONNREFUSED 127.0.0.1:443'
    )
  })

  it('redacts a Stellar secret seed', () => {
    const seed = 'S' + 'A'.repeat(55)
    const result = sanitizeErrorMessage(`invalid signer ${seed} rejected`)
    expect(result).not.toContain(seed)
    expect(result).toContain('[REDACTED]')
  })

  it('redacts cleanly with no offset-number artifact when the match is not at index 0', () => {
    // Regression test: a naive regex replacer using (match, prefix) => ...
    // misreads the match offset as a capture group for patterns with no
    // groups, leaking the numeric offset (e.g. "15[REDACTED]") into output.
    const seed = 'S' + 'A'.repeat(55)
    const result = sanitizeErrorMessage(`invalid signer ${seed} rejected`)
    expect(result).toBe('invalid signer [REDACTED] rejected')
  })

  it('redacts a Bearer token', () => {
    const result = sanitizeErrorMessage('request failed: Authorization: Bearer abc123.def456-ghi')
    expect(result).not.toContain('abc123.def456-ghi')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abcdefghijklmnop'
    const result = sanitizeErrorMessage(`token invalid: ${jwt}`)
    expect(result).not.toContain(jwt)
    expect(result).toContain('[REDACTED]')
  })

  it('redacts api_key= / token= style query params while keeping the key name', () => {
    const result = sanitizeErrorMessage('GET /webhook?api_key=sk_live_abcdefg123456 failed with 500')
    expect(result).not.toContain('sk_live_abcdefg123456')
    expect(result).toContain('api_key=[REDACTED]')
  })

  it('redacts email addresses', () => {
    const result = sanitizeErrorMessage('delivery failed for user jane.doe@example.com')
    expect(result).not.toContain('jane.doe@example.com')
    expect(result).toContain('[REDACTED]')
  })

  it('truncates messages longer than the max length and appends a marker', () => {
    const longMessage = 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 500)
    const result = sanitizeErrorMessage(longMessage)
    expect(result.length).toBe(MAX_ERROR_MESSAGE_LENGTH + '...[truncated]'.length)
    expect(result.endsWith('...[truncated]')).toBe(true)
  })

  it('does not truncate messages at or under the max length', () => {
    const message = 'y'.repeat(MAX_ERROR_MESSAGE_LENGTH)
    const result = sanitizeErrorMessage(message)
    expect(result).toBe(message)
  })

  it('redacts a secret straddling the truncation boundary before cutting the string', () => {
    const seed = 'S' + 'B'.repeat(55)
    // Position the secret so it spans across MAX_ERROR_MESSAGE_LENGTH: if
    // truncation ran before redaction, half the raw seed would survive.
    const padding = 'z'.repeat(MAX_ERROR_MESSAGE_LENGTH - 5)
    const result = sanitizeErrorMessage(`${padding}${seed}`)
    expect(result).not.toContain(seed.slice(0, 10))
    expect(result).not.toContain('B'.repeat(10))
  })
})
